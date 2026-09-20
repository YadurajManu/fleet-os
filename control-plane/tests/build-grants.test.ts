import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { signGrant, verifyGrant, type BuildGrant } from '../src/build/credentials.js'
const grant:BuildGrant={job:randomUUID(),node:randomUUID(),attempt:1,repo:`fleet-builds/${randomUUID()}`,exp:Date.now()+60000,purpose:'push'}
test('build grants are signed, expire, and are purpose scoped',()=>{
 const token=signGrant(grant,'test-secret')
 assert.deepEqual(verifyGrant(token,'test-secret','push'),grant)
 assert.equal(verifyGrant(token+'x','test-secret','push'),null)
 assert.equal(verifyGrant(token,'wrong','push'),null)
 assert.equal(verifyGrant(token,'test-secret','source'),null)
 assert.equal(verifyGrant(token,'test-secret','push',grant.exp+1),null)
})
