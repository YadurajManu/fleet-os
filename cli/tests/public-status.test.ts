import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { statusCommand } from '../src/commands/status.js'
test('public status needs no user credentials or selected fleet and sends no authorization', async () => {
  const calls: string[] = []
  const server = createServer((req,res) => { calls.push(req.url!); assert.equal(req.headers.authorization,undefined); res.setHeader('content-type','application/json'); res.end(JSON.stringify({ status:'unknown',stale:true,as_of:null,components:[{ name:'API',status:'unknown',uptime:null }] })) })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const saved = { FLEET_API:process.env.FLEET_API,FLEET_TOKEN:process.env.FLEET_TOKEN,FLEET_CONFIG:process.env.FLEET_CONFIG }
  process.env.FLEET_API = `http://127.0.0.1:${(server.address() as { port:number }).port}`
  process.env.FLEET_TOKEN = 'must-not-leak'; process.env.FLEET_CONFIG = '/tmp/fleet-public-status-no-profile.json'
  try { await statusCommand.run([],{ public:true,json:true }); assert.deepEqual(calls,['/v1/status']) }
  finally { for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key]=value }; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
