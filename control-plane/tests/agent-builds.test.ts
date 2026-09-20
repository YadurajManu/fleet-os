import 'dotenv/config'
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {eq} from 'drizzle-orm'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createContext,closeContext,type AppContext} from '../src/api/context.js'
import {loadConfig} from '../src/config.js'
import {AgentBuildRunner} from '../src/build/agent.js'
import {orgs,fleets,nodes,services,deployments,buildJobs} from '../src/db/schema.js'
import {verifyGrant} from '../src/build/credentials.js'
import type {BuildAssignment} from '../src/build/protocol.js'
import type {BuildRequest} from '../src/build/runner.js'
let ctx:AppContext,runner:AgentBuildRunner,dir:string,orgId:string,fleetId:string,serviceId:string,nodeId:string
const digest=`sha256:${'a'.repeat(64)}`
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'fleet-agent-build-test-'))
 ctx=createContext({...loadConfig(),BUILD_MODE:'agent',PUBLIC_API_URL:'https://api.example.test',REGISTRY_URL:'registry.example.test',BUILD_WORKDIR:dir})
 runner=ctx.builds as AgentBuildRunner
 const [o]=await ctx.db.insert(orgs).values({name:'agent-build-tests'}).returning();orgId=o!.id
 const [f]=await ctx.db.insert(fleets).values({orgId,name:'test'}).returning();fleetId=f!.id
 const [s]=await ctx.db.insert(services).values({fleetId,name:'app',buildContext:'.'}).returning();serviceId=s!.id
 const [n]=await ctx.db.insert(nodes).values({fleetId,name:'mac',arch:'arm64',platform:'linux/arm64',os:'linux',cpuCores:8,ramMb:16384,effectiveCpu:8,effectiveMemBytes:16*1073741824,diskMb:100000,buildCacheFreeBytes:100*1073741824,canBuild:true,status:'online',agentTokenHash:'test-build-hash'}).returning();nodeId=n!.id
 await writeFile(join(dir,'Dockerfile'),'FROM scratch\n')
 ctx.tunnels.has=()=>true
})
after(async()=>{runner.close();await ctx.db.delete(orgs).where(eq(orgs.id,orgId));await closeContext(ctx);await rm(dir,{recursive:true,force:true})})
async function request(sourceKey:string):Promise<BuildRequest>{
 const [d]=await ctx.db.insert(deployments).values({serviceId,nodeId,status:'building'}).returning()
 return {deploymentId:d!.id,serviceId,fleetId,serviceName:'app',gitSha:'a'.repeat(40),buildContext:'.',contextRoot:dir,platforms:['linux/arm64'],registry:'registry.example.test',sourceKey}
}
test('assignment has scoped credentials; wrong attempts and nodes cannot finish it; result uses digest',async()=>{
 const req=await request('commit-one')
 let task:Promise<void>|undefined
 ctx.tunnels.sendBuild=(id,msg)=>{
  const a=msg as BuildAssignment;if(a.type!=='build.assign')return true
  task=(async()=>{
   assert.equal(id,nodeId)
   assert.equal(a.platform,'linux/arm64')
   assert.equal(verifyGrant(a.registry_password,ctx.config.JWT_SECRET,'push')?.repo,`fleet-builds/${serviceId}`)
   assert.equal(verifyGrant(a.source.token,ctx.config.JWT_SECRET,'push'),null)
   const event={type:'build.result',version:1,job_id:a.job_id,attempt:a.attempt,status:'succeeded',digest}
   await runner.handleMessage('wrong-node',event)
   await runner.handleMessage(id,{...event,attempt:a.attempt+1})
   const [pending]=await ctx.db.select().from(buildJobs).where(eq(buildJobs.id,a.job_id));assert.equal(pending!.status,'assigned')
   await runner.handleMessage(id,{...event,type:'build.ack',status:'running'})
   await runner.handleMessage(id,event)
  })();return true
 }
 const result=await runner.build(req);await task
 assert.equal(result.imageTags[0],`registry.example.test/fleet-builds/${serviceId}@${digest}`)
})
test('same source, service and platform reuse a successful digest',async()=>{
 ctx.tunnels.sendBuild=()=>{throw new Error('dedupe unexpectedly assigned a build')}
 const result=await runner.build(await request('commit-one'))
 assert.equal(result.digest,digest)
})
test('no opted-in builder fails clearly and leaves no active jobs',async()=>{
 await ctx.db.update(nodes).set({canBuild:false}).where(eq(nodes.id,nodeId))
 const req=await request('no-builder')
 await assert.rejects(runner.build(req),/no build-capable linux\/arm64 agent/)
 const jobs=await ctx.db.select().from(buildJobs).where(eq(buildJobs.deploymentId,req.deploymentId!))
 assert.ok(jobs.every(j=>!['queued','assigned','running'].includes(j.status)))
 await ctx.db.update(nodes).set({buildCacheFreeBytes:100*1073741824,canBuild:true}).where(eq(nodes.id,nodeId))
})
test('operator cancellation stops the assigned attempt and returns a terminal error',async()=>{
 const req=await request('cancel')
 let cancelSent=false
 ctx.tunnels.sendBuild=(id,msg)=>{const a=msg as BuildAssignment;if(a.type==='build.assign')void runner.cancel(req.deploymentId!);else if((msg as {type:string}).type==='build.cancel')cancelSent=true;return true}
 await assert.rejects(runner.build(req),/cancelled/)
 assert.equal(cancelSent,true)
})
test('expired lease retries on another native builder; late result is fenced',async()=>{
 const [n]=await ctx.db.insert(nodes).values({fleetId,name:'other',arch:'arm64',platform:'linux/arm64',cpuCores:8,ramMb:16384,effectiveCpu:8,effectiveMemBytes:16*1073741824,diskMb:100000,buildCacheFreeBytes:100*1073741824,canBuild:true,status:'online',agentTokenHash:'test-build-hash-two'}).returning()
 const assigned:string[]=[];let previous:BuildAssignment|undefined;let task:Promise<void>|undefined
 ctx.tunnels.sendBuild=(id,msg)=>{
  const a=msg as BuildAssignment;if(a.type!=='build.assign')return true
  assigned.push(id)
  task=(async()=>{
   if(!previous){previous=a;await ctx.db.update(buildJobs).set({leaseExpiresAt:new Date(0)}).where(eq(buildJobs.id,a.job_id));return}
   await runner.handleMessage(assigned[0]!,{type:'build.result',version:1,job_id:a.job_id,attempt:previous.attempt,status:'succeeded',digest:`sha256:${'b'.repeat(64)}`})
   await runner.handleMessage(id,{type:'build.result',version:1,job_id:a.job_id,attempt:a.attempt,status:'succeeded',digest})
  })();return true
 }
 const result=await runner.build(await request('retry'));await task
 assert.equal(result.digest,digest);assert.equal(assigned.length,2);assert.notEqual(assigned[0],assigned[1])
 await ctx.db.delete(nodes).where(eq(nodes.id,n!.id))
})

test('agent builds are the default, local remains an explicit fallback',()=>{
 assert.equal(loadConfig({...process.env,BUILD_MODE:undefined}).BUILD_MODE,'agent')
 assert.equal(runner.name,'agent')
})
