import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppContext } from '../api/context.js'
import { buildJobs, deployments, nodes, services } from '../db/schema.js'
import { fleetSnapshot } from '../scheduler/snapshot.js'
import { publishLog } from '../api/log-stream.js'
import { containedContext, planBuilds } from './buildx.js'
import { buildEvent, type BuildAssignment } from './protocol.js'
import { signGrant } from './credentials.js'
import { archivePath } from './transfers.js'
import { selectBuilder, type Builder } from './platforms.js'
import { mergeManifests } from './manifests.js'
import { BuildUnavailableError, type BuildRequest, type BuildResult, type BuildRunner } from './runner.js'
const exec = promisify(execFile)
export const LEASE_MS = 45_000
const ACTIVE = ['assigned','running'] as const
const sleep = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

export class AgentBuildRunner implements BuildRunner {
 readonly name='agent'
 private inFlight=new Set<string>()
 private timer:ReturnType<typeof setInterval>
 constructor(private ctx:AppContext) {
  this.timer=setInterval(()=>{void this.reapOrphans().catch(()=>{})},10000);this.timer.unref()
 }
 close(){clearInterval(this.timer)}
 async available(){return Boolean(this.ctx.config.PUBLIC_API_URL && this.ctx.config.REGISTRY_URL)}
 private send(nodeId:string,msg:unknown){return this.ctx.tunnels.sendBuild(nodeId,msg)}
 async handleMessage(nodeId:string,raw:unknown){
  const parsed=buildEvent.safeParse(raw);if(!parsed.success)return
  const event=parsed.data
  const [job]=await this.ctx.db.select().from(buildJobs).where(eq(buildJobs.id,event.job_id)).limit(1)
  if(!job || job.builderNodeId!==nodeId || job.attempt!==event.attempt)return
  const receipt={type:'build.receipt',version:1,job_id:job.id,attempt:job.attempt}
  if(!ACTIVE.includes(job.status as typeof ACTIVE[number])){this.send(nodeId,receipt);return}
  if(!this.inFlight.has(job.deploymentId) || !job.leaseExpiresAt || job.leaseExpiresAt.getTime()<=Date.now()){
   this.send(nodeId,{...receipt,type:'build.cancel'});return
  }
  const fence=and(eq(buildJobs.id,job.id),eq(buildJobs.attempt,event.attempt),eq(buildJobs.builderNodeId,nodeId),inArray(buildJobs.status,[...ACTIVE]))
  if(event.type==='build.ack' || event.type==='build.renew'){
   await this.ctx.db.update(buildJobs).set({status:'running',leaseExpiresAt:new Date(Date.now()+LEASE_MS)}).where(fence)
  }else if(event.type==='build.log' && event.text){
   const [service]=await this.ctx.db.select().from(services).where(eq(services.id,job.serviceId)).limit(1)
   if(!service)return
   const entry={service:service.name,serviceId:service.id,nodeId,deploymentId:job.deploymentId,text:event.text,at:Date.now()}
   await this.ctx.redis.multi().lpush(`build:logs:${service.id}`,JSON.stringify(entry)).ltrim(`build:logs:${service.id}`,0,199).expire(`build:logs:${service.id}`,86400).exec()
   await publishLog(this.ctx.redis,service.name,entry)
  }else if(event.type==='build.result'){
   const status=event.status==='succeeded' && event.digest ? 'succeeded' : event.status==='cancelled' ? 'cancelled' : 'failed'
   await this.ctx.db.update(buildJobs).set({status,imageDigest:status==='succeeded'?event.digest:null,error:event.error??(status==='failed'?'build failed or returned no digest':null),finishedAt:new Date(),leaseExpiresAt:null}).where(fence)
   this.send(nodeId,receipt)
  }
 }
 async cancel(deploymentId:string){
  const jobs=await this.ctx.db.update(buildJobs).set({status:'cancelled',finishedAt:new Date(),leaseExpiresAt:null,error:'cancelled by operator'})
   .where(and(eq(buildJobs.deploymentId,deploymentId),inArray(buildJobs.status,['queued',...ACTIVE]))).returning()
  for(const job of jobs)if(job.builderNodeId)this.send(job.builderNodeId,{type:'build.cancel',version:1,job_id:job.id,attempt:job.attempt})
 }
 private async reapOrphans(){
  const expired=await this.ctx.db.select().from(buildJobs).where(and(inArray(buildJobs.status,[...ACTIVE]),lt(buildJobs.leaseExpiresAt,new Date())))
  for(const job of expired){
   if(this.inFlight.has(job.deploymentId))continue
   await this.ctx.db.update(buildJobs).set({status:'timed_out',error:'control plane restarted or build lease expired',finishedAt:new Date()}).where(and(eq(buildJobs.id,job.id),eq(buildJobs.attempt,job.attempt),lt(buildJobs.leaseExpiresAt,new Date()),inArray(buildJobs.status,[...ACTIVE])))
   await this.ctx.db.update(deployments).set({status:'failed',failureReason:'build_lease_expired: retry the deployment',finishedAt:new Date()}).where(and(eq(deployments.id,job.deploymentId),inArray(deployments.status,['queued','building','pushing'])))
   if(job.builderNodeId)this.send(job.builderNodeId,{type:'build.cancel',version:1,job_id:job.id,attempt:job.attempt})
  }
 }
 private async reserve(job:typeof buildJobs.$inferSelect,req:BuildRequest,excluded:Set<string>){
  return this.ctx.db.transaction(async tx=>{
   // Serialize builder allocation across requests/processes using node rows.
   const rows=await tx.select().from(nodes).where(eq(nodes.fleetId,req.fleetId!)).orderBy(asc(nodes.id)).for('update')
   const snapshot=await fleetSnapshot({...this.ctx,db:tx as unknown as AppContext['db']},req.fleetId!)
   const active=await tx.select().from(buildJobs).where(inArray(buildJobs.status,[...ACTIVE]))
   const [previous]=await tx.select().from(buildJobs).where(and(eq(buildJobs.serviceId,req.serviceId!),eq(buildJobs.platform,job.platform),eq(buildJobs.status,'succeeded'))).orderBy(desc(buildJobs.finishedAt)).limit(1)
   const pool:Builder[]=rows.map(n=>{
    const capacity=snapshot.nodes.find(x=>x.id===n.id)!
    return {id:n.id,platform:n.platform,canBuild:n.canBuild && n.status==='online' && !excluded.has(n.id),connected:this.ctx.tunnels.has(n.id),
     active:active.filter(j=>j.builderNodeId===n.id).length,maxConcurrentBuilds:n.maxConcurrentBuilds,
     freeCpu:(n.effectiveCpu??0)-(capacity.committedCpu??0),freeMemBytes:(n.effectiveMemBytes??0)-capacity.committedRamMb*1048576,
     buildCacheFreeBytes:n.buildCacheFreeBytes,load:capacity.loadFactor??0.5,reliabilityScore:n.reliabilityScore}
   })
   const builder=selectBuilder(pool,job.platform,previous?.builderNodeId??null,this.ctx.config.ALLOW_QEMU_FALLBACK)
   if(!builder)throw new BuildUnavailableError(`no build-capable ${job.platform} agent online with available CPU/memory/concurrency`)
   const [assigned]=await tx.update(buildJobs).set({status:'assigned',builderNodeId:builder.id,attempt:job.attempt+1,leaseExpiresAt:new Date(Date.now()+LEASE_MS),startedAt:new Date(),finishedAt:null,error:null})
    .where(and(eq(buildJobs.id,job.id),eq(buildJobs.attempt,job.attempt),inArray(buildJobs.status,['queued','timed_out']))).returning()
   if(!assigned)throw new Error('build cancelled before assignment')
   return {job:assigned,builder}
  })
 }
 private async runJob(initial:typeof buildJobs.$inferSelect,req:BuildRequest,checksum:string,origin:URL,repo:string){
  let job=initial
  const excluded=new Set<string>()
  for(let retry=0;retry<3;retry++){
   const assigned=await this.reserve(job,req,excluded);job=assigned.job
   const {builder}=assigned
   const exp=Date.now()+Math.min(this.ctx.config.BUILD_TIMEOUT_MS,3600000)+60000
   const grant={job:job.id,attempt:job.attempt,node:builder.id,repo,exp}
   const emulated=builder.platform!==job.platform
   req.onProgress?.({phase:'building',platform:job.platform,builder:builder.id,emulated,detail:`assigned to ${builder.id}${emulated?' (slow QEMU fallback)':''}`})
   const assignment:BuildAssignment={type:'build.assign',version:1,job_id:job.id,attempt:job.attempt,platform:job.platform,cache_key:`${req.serviceId}:${job.platform}`,emulated,
    source:{url:new URL(`/agent/build-source/${job.id}`,origin).href,token:signGrant({...grant,purpose:'source'},this.ctx.config.JWT_SECRET),sha256:checksum},
    dockerfile:'Dockerfile',registry_target:`${origin.host}/${repo}:${req.gitSha.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,40)||'source'}-${job.platform.replaceAll('/','-')}-${job.id.slice(0,8)}-${job.attempt}`,
    registry_username:'build',registry_password:signGrant({...grant,purpose:'push'},this.ctx.config.JWT_SECRET),timeout_ms:Math.min(this.ctx.config.BUILD_TIMEOUT_MS,3600000),cpu:2,memory_bytes:2147483648,disk_bytes:20*1073741824}
   if(!this.send(builder.id,assignment))await this.ctx.db.update(buildJobs).set({leaseExpiresAt:new Date(0)}).where(eq(buildJobs.id,job.id))
   const deadline=Date.now()+assignment.timeout_ms
   while(true){
    await sleep(500)
    const [current]=await this.ctx.db.select().from(buildJobs).where(eq(buildJobs.id,job.id)).limit(1)
    if(!current)throw new Error('build was removed')
    job=current
    if(job.status==='succeeded' && job.imageDigest)return job.imageDigest
    if(job.status==='failed' || job.status==='cancelled')throw new Error(job.error??`build ${job.status}`)
    if(Date.now()>deadline || !job.leaseExpiresAt || job.leaseExpiresAt.getTime()<=Date.now()){
     this.send(builder.id,{type:'build.cancel',version:1,job_id:job.id,attempt:job.attempt})
     await this.ctx.db.update(buildJobs).set({status:'timed_out',error:'builder lease expired or build timed out',finishedAt:new Date(),leaseExpiresAt:null}).where(and(eq(buildJobs.id,job.id),eq(buildJobs.attempt,job.attempt),inArray(buildJobs.status,[...ACTIVE])))
     excluded.add(builder.id);break
    }
   }
  }
  throw new Error('build timed out after 3 attempts')
 }
 async build(req:BuildRequest):Promise<BuildResult>{
  if(!req.deploymentId || !req.serviceId || !req.fleetId)throw new BuildUnavailableError('agent builds require deployment, service and fleet identity')
  if(!await this.available())throw new BuildUnavailableError('agent builds require PUBLIC_API_URL and REGISTRY_URL')
  const origin=new URL(this.ctx.config.PUBLIC_API_URL!)
  if(origin.protocol!=='https:' || origin.pathname!=='/')throw new BuildUnavailableError('PUBLIC_API_URL must be an HTTPS origin serving /agent/build-source and /v2/')
  if(!req.platforms.length)throw new BuildUnavailableError('no eligible Linux platforms')
  const started=Date.now(),deploymentId=req.deploymentId,repo=`fleet-builds/${req.serviceId}`
  const archive=archivePath(this.ctx.config.BUILD_WORKDIR,deploymentId)
  const context=containedContext(req.contextRoot??this.ctx.config.BUILD_WORKDIR,req.buildContext)
  await mkdir(dirname(archive),{recursive:true,mode:0o700})
  this.inFlight.add(deploymentId)
  try{
   await exec('tar',['-czf',archive,'--exclude=.git','-C',context,'.'],{timeout:60000})
   if((await stat(archive)).size>256*1048576)throw new Error('source archive exceeds 256MiB')
   const checksum=createHash('sha256').update(await readFile(archive)).digest('hex')
   const sourceRef=req.sourceKey??checksum
   const groups=planBuilds(req.platforms,new Map(req.platforms.map(p=>[p,p])))
   const jobs:Promise<string>[]=[]
   for(const group of groups){
    const platform=group.platforms[0]!
    const [cached]=await this.ctx.db.select().from(buildJobs).where(and(eq(buildJobs.serviceId,req.serviceId),eq(buildJobs.platform,platform),eq(buildJobs.sourceRef,sourceRef),eq(buildJobs.status,'succeeded'))).orderBy(desc(buildJobs.finishedAt)).limit(1)
    if(cached?.imageDigest){
     await this.ctx.db.insert(buildJobs).values({deploymentId,serviceId:req.serviceId,platform,sourceRef,status:'succeeded',imageDigest:cached.imageDigest,finishedAt:new Date()})
     req.onProgress?.({phase:'building',platform,detail:'reusing previously built digest'})
     jobs.push(Promise.resolve(cached.imageDigest));continue
    }
    const [job]=await this.ctx.db.insert(buildJobs).values({deploymentId,serviceId:req.serviceId,platform,sourceRef}).returning()
    jobs.push(this.runJob(job!,req,checksum,origin,repo))
   }
   const outcomes=await Promise.allSettled(jobs.map(p=>p.catch(async err=>{await this.cancel(deploymentId);throw err})))
   const failure=outcomes.find(x=>x.status==='rejected')
   if(failure?.status==='rejected')throw failure.reason
   const digests=outcomes.map(x=>(x as PromiseFulfilledResult<string>).value)
   const registry=this.ctx.config.REGISTRY_URL!.replace(/^https?:\/\//,'').replace(/\/$/,'')
   const imageRepo=`${registry}/${repo}`
   const digest=digests.length===1?digests[0]!:await mergeManifests(imageRepo,`${deploymentId}`,digests,this.ctx.config.REGISTRY_CREDENTIALS)
   await this.ctx.db.update(services).set({imagePlatforms:req.platforms}).where(eq(services.id,req.serviceId))
   return {imageTags:[`${imageRepo}@${digest}`],digest,durationMs:Date.now()-started}
  }finally{this.inFlight.delete(deploymentId);await this.cancel(deploymentId);await rm(archive,{force:true})}
 }
}
