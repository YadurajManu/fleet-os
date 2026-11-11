import test from 'node:test'
import assert from 'node:assert/strict'
import { progressLine, type DeployProgress } from '../src/progress.js'

test('a pending rollout shows its error instead of stale pull progress', () => {
  const progress: DeployProgress = {
    deploymentId: 'deployment', status: 'deploying', since: new Date().toISOString(),
    gitSha: null, nodeName: 'builder', failureReason: 'pull: invalid reference format',
    detail: 'pulling 0/3 layers',
  }
  assert.equal(progressLine(progress), 'reconciliation failed: pull: invalid reference format; retrying')
  assert.equal(progressLine({ ...progress, failureReason: null }), 'pulling 0/3 layers')
})
