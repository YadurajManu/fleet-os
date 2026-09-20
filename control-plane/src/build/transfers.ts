import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Readable } from 'node:stream'
import { buildJobs } from '../db/schema.js'
import { verifyGrant, type BuildGrant } from './credentials.js'
import type { AppContext } from '../api/context.js'

export function archivePath(workdir: string, deploymentId: string): string { return join(workdir,'delegated',`${deploymentId}.tgz`) }
async function activeGrant(ctx: AppContext, grant: BuildGrant | null) {
 if (!grant) return null
 const [job] = await ctx.db.select().from(buildJobs).where(eq(buildJobs.id,grant.job)).limit(1)
 return job && job.builderNodeId===grant.node && job.attempt===grant.attempt && ['assigned','running'].includes(job.status)
  && job.leaseExpiresAt && job.leaseExpiresAt.getTime()>Date.now() && grant.repo===`fleet-builds/${job.serviceId}` ? job : null
}

export async function buildTransferRoutes(app: FastifyInstance) {
 const ctx=app.ctx
 app.get<{Params:{jobId:string}}>('/agent/build-source/:jobId', async (req,reply)=>{
  const grant=verifyGrant((req.headers.authorization??'').replace(/^Bearer /,''),ctx.config.JWT_SECRET,'source')
  const job=await activeGrant(ctx,grant)
  if (!job || job.id!==req.params.jobId) return reply.code(403).send({error:'source grant expired or invalid'})
  return reply.header('Cache-Control','no-store').type('application/gzip').send(createReadStream(archivePath(ctx.config.BUILD_WORKDIR,job.deploymentId)))
 })
 // A small scoped registry gateway: agents never receive the upstream registry
 // credential. Docker speaks its ordinary Basic-auth protocol with a signed,
 // short-lived attempt token. Upstream registry auth remains unchanged for old agents.
 await app.register(async registry=>{
  registry.removeAllContentTypeParsers()
  registry.addContentTypeParser('*', (req,payload,done)=>done(null,payload))
  registry.all('/v2/*', async(req,reply)=>{
   let token=''
   try { const basic=Buffer.from((req.headers.authorization??'').replace(/^Basic /,''),'base64').toString();token=basic.slice(basic.indexOf(':')+1) } catch {}
   const grant=verifyGrant(token,ctx.config.JWT_SECRET,'push')
   const job=await activeGrant(ctx,grant)
   if (!job || !grant) return reply.header('WWW-Authenticate','Basic realm="Fleet build registry"').code(401).send()
   const path=new URL(req.raw.url??'/', 'http://registry.local')
   if (path.pathname !== '/v2/' && !path.pathname.startsWith(`/v2/${grant.repo}/`)) return reply.code(403).send()
   if (path.pathname.includes('%') || (req.method === 'DELETE' && !path.pathname.includes('/blobs/uploads/'))) return reply.code(403).send()
   // Cross-repository blob mounts would bypass the repository scope.
   if (path.searchParams.has('from') || path.searchParams.has('mount')) return reply.code(403).send()
   if (!ctx.config.REGISTRY_URL) return reply.code(503).send()
   const origin=new URL(ctx.config.REGISTRY_URL.includes('://') ? ctx.config.REGISTRY_URL : `https://${ctx.config.REGISTRY_URL}`)
   const target=new URL(path.pathname+path.search,origin)
   const headers: Record<string,string>={}
   for (const name of ['content-type','content-length','range','accept','docker-distribution-api-version']) {
    const value=req.headers[name];if(typeof value==='string')headers[name]=value
   }
   if(ctx.config.REGISTRY_CREDENTIALS)headers.authorization=`Basic ${Buffer.from(ctx.config.REGISTRY_CREDENTIALS).toString('base64')}`
   const upstream=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:req.method,headers,timeout:300000})
   return await new Promise<void>((resolve,reject)=>{
    upstream.on('timeout',()=>upstream.destroy(new Error('registry request timed out')))
    upstream.on('error',()=>{if(!reply.sent)reply.code(502).send({error:'upstream registry unavailable'});resolve()})
    req.raw.on('aborted',()=>upstream.destroy())
    upstream.on('response',res=>{
     reply.code(res.statusCode??502)
     for(const name of ['content-type','content-length','docker-content-digest','docker-upload-uuid','range','docker-distribution-api-version']) {
      const value=res.headers[name];if(value)reply.header(name,value)
     }
     if(res.headers.location){
      const location=new URL(res.headers.location,origin)
      if(location.origin!==origin.origin || !location.pathname.startsWith(`/v2/${grant.repo}/`)){res.resume();reply.code(502).send({error:'unsupported upstream registry redirect'});resolve();return}
      // Relative Location keeps the client on this authenticated gateway.
      reply.header('Location',location.pathname+location.search)
     }
     reply.send(res);resolve()
    })
    const body=req.body as Readable|undefined
    if(body && typeof body.pipe==='function'){body.on('error',()=>upstream.destroy());body.pipe(upstream)}else upstream.end()
   })
  })
 })
}
