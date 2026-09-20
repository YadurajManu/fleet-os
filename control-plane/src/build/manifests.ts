import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const exec=promisify(execFile)
/** Same registry-only imagetools operation used by BuildxRunner, without a build daemon. */
export async function mergeManifests(repo:string,tag:string,digests:string[],credentials?:string):Promise<string>{
 if(!digests.length || digests.some(d=>!/^sha256:[a-f0-9]{64}$/.test(d)))throw new Error('invalid per-platform image digest')
 const dir=await mkdtemp(join(tmpdir(),'fleet-manifests-'))
 const env={...process.env,DOCKER_CONFIG:dir}
 try{
  if(credentials){
   const separator=credentials.indexOf(':');if(separator<1)throw new Error('invalid registry credentials')
   await new Promise<void>((resolve,reject)=>{
    const child=spawn('docker',['login',repo.split('/')[0]!,'--username',credentials.slice(0,separator),'--password-stdin'],{env,stdio:['pipe','ignore','ignore'],timeout:30000})
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('registry authentication failed')));child.stdin.end(credentials.slice(separator+1))
   })
  }
  await exec('docker',['buildx','imagetools','create','--tag',`${repo}:${tag}`,...digests.map(d=>`${repo}@${d}`)],{env,timeout:300000,maxBuffer:1048576})
  const {stdout}=await exec('docker',['buildx','imagetools','inspect','--format','{{.Manifest.Digest}}',`${repo}:${tag}`],{env,timeout:30000})
  const digest=stdout.trim();if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('manifest digest missing')
  return digest
 }catch{throw new Error('registry manifest assembly failed; inspect registry connectivity and per-platform digests')}
 finally{await rm(dir,{recursive:true,force:true})}
}
