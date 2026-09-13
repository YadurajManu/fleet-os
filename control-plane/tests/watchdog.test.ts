import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCanaryHealth,
  recordCanaryHealthy,
  CANARY_WINDOW_MS,
  CONSECUTIVE_UNHEALTHY_THRESHOLD,
} from '../src/heartbeat/watchdog.js'
import type { AppContext } from '../src/api/context.js'
import type { FleetEventPayload } from '../src/lib/events.js'

describe('canary watchdog for proactive auto-rollback', () => {
  function makeMockContext(overrides: {
    deploymentsList?: any[]
    svcRow?: any
    redisStore?: Map<string, string>
  } = {}) {
    const redisStore = overrides.redisStore ?? new Map<string, string>()
    const deploymentsList = overrides.deploymentsList ?? []
    const auditLogs: any[] = []
    const invalidated: string[] = []

    const makeQuery = (data: any[]) => ({
      orderBy: () => ({
        limit: () => data,
      }),
      limit: () => data,
      then: (resolve: any, reject: any) => Promise.resolve(data).then(resolve, reject),
      [Symbol.iterator]: () => data[Symbol.iterator](),
    })

    const mockDb: any = {
      select: () => ({
        from: (table: any) => ({
          where: (cond: any) => makeQuery(deploymentsList),
          innerJoin: () => ({
            where: () => (overrides.svcRow ? [overrides.svcRow] : []),
          }),
        }),
      }),
      transaction: async (fn: any) => {
        const tx: any = {
          update: (table: any) => ({
            set: (vals: any) => ({
              where: (cond: any) => {
                const target = deploymentsList.find((d) => d.id === 'curr-1')
                if (target) Object.assign(target, vals)
                return [target]
              },
            }),
          }),
          insert: (table: any) => ({
            values: (vals: any) => ({
              returning: () => {
                const created = { id: 'new-deploy-id', startedAt: new Date(), ...vals }
                deploymentsList.unshift(created)
                return [created]
              },
            }),
          }),
        }
        return fn(tx)
      },
      update: () => ({
        set: () => ({
          where: () => [],
        }),
      }),
    }

    const mockRedis: any = {
      incr: async (key: string) => {
        const curr = parseInt(redisStore.get(key) ?? '0', 10) + 1
        redisStore.set(key, String(curr))
        return curr
      },
      expire: async () => 1,
      del: async (key: string) => {
        redisStore.delete(key)
        return 1
      },
      set: async (key: string, val: string, ...args: any[]) => {
        if (args.includes('NX') && redisStore.has(key)) return null
        redisStore.set(key, val)
        return 'OK'
      },
      get: async (key: string) => redisStore.get(key) ?? null,
    }

    const ctx = {
      db: mockDb,
      redis: mockRedis,
      config: {} as any,
    } as unknown as AppContext

    return { ctx, deploymentsList, redisStore, auditLogs, invalidated }
  }

  test('skips if current deployment is outside the canary window', async () => {
    const oldStarted = new Date(Date.now() - (CANARY_WINDOW_MS + 10_000))
    const { ctx } = makeMockContext({
      deploymentsList: [
        {
          id: 'curr-1',
          serviceId: 'svc-1',
          status: 'running',
          startedAt: oldStarted,
          finishedAt: oldStarted,
          imageTags: ['myrepo:v2'],
        },
      ],
    })

    const res = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'crash_loop',
    })

    assert.equal(res.action, 'skipped')
    assert.equal(res.reason, 'outside_canary_window')
  })

  test('consecutive unhealthy threshold guards against premature rollback', async () => {
    const recentStarted = new Date(Date.now() - 30_000)
    const { ctx } = makeMockContext({
      deploymentsList: [
        {
          id: 'curr-1',
          serviceId: 'svc-1',
          status: 'running',
          startedAt: recentStarted,
          finishedAt: recentStarted,
          imageTags: ['myrepo:v2'],
        },
      ],
    })

    // First unhealthy report
    const res1 = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'unhealthy',
    })
    assert.equal(res1.action, 'skipped')
    assert.equal(res1.reason, 'consecutive_unhealthy_1')

    // Second unhealthy report
    const res2 = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'unhealthy',
    })
    assert.equal(res2.action, 'skipped')
    assert.equal(res2.reason, 'consecutive_unhealthy_2')

    // Now healthy report resets it
    await recordCanaryHealthy(ctx, 'curr-1')

    // Third report after reset is count 1 again
    const res3 = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'unhealthy',
    })
    assert.equal(res3.action, 'skipped')
    assert.equal(res3.reason, 'consecutive_unhealthy_1')
  })

  test('skips if no previous healthy release is available to restore', async () => {
    const recentStarted = new Date(Date.now() - 30_000)
    const { ctx } = makeMockContext({
      deploymentsList: [
        {
          id: 'curr-1',
          serviceId: 'svc-1',
          status: 'running',
          startedAt: recentStarted,
          finishedAt: recentStarted,
          imageTags: ['myrepo:v1'],
        },
      ],
    })

    const res = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'crash_loop',
    })

    assert.equal(res.action, 'skipped')
    assert.equal(res.reason, 'no_rollback_target')
  })

  test('executes rollback and emits event on crash loop within canary window', async () => {
    const recentStarted = new Date(Date.now() - 45_000)
    const events: FleetEventPayload[] = []

    const currentDeploy = {
      id: 'curr-1',
      serviceId: 'svc-1',
      status: 'running',
      startedAt: recentStarted,
      finishedAt: recentStarted,
      imageTags: ['myrepo:v2'],
      nodeId: 'node-1',
      hostPort: 3000,
    }

    const previousHealthy = {
      id: 'prev-good',
      serviceId: 'svc-1',
      status: 'superseded',
      startedAt: new Date(Date.now() - 3600_000),
      finishedAt: new Date(Date.now() - 3500_000),
      imageTags: ['myrepo:v1'],
      nodeId: 'node-1',
      hostPort: 3000,
    }

    const { ctx, deploymentsList } = makeMockContext({
      deploymentsList: [currentDeploy, previousHealthy],
      svcRow: { orgId: 'org-1', fleetId: 'fleet-1', name: 'api' },
    })

    const res = await evaluateCanaryHealth(
      ctx,
      {
        serviceId: 'svc-1',
        deploymentId: 'curr-1',
        nodeId: 'node-1',
        trigger: 'crash_loop',
      },
      {
        onEvent: (e) => {
          events.push(e)
        },
      }
    )

    assert.equal(res.action, 'rolled_back')
    assert.equal(res.fromDeploymentId, 'curr-1')
    assert.equal(res.targetDeploymentId, 'prev-good')
    assert.equal(currentDeploy.status, 'failed')
    assert.match((currentDeploy as any).failureReason, /auto-rollback: crash_loop/)

    // Event was emitted
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'service.auto_rolled_back')
    assert.equal(events[0]!.subject, 'api')
    assert.equal(events[0]!.detail?.fromDeploymentId, 'curr-1')
    assert.equal(events[0]!.detail?.targetDeploymentId, 'prev-good')

    // Second evaluation on the same deployment is prevented by Redis guard
    const resAgain = await evaluateCanaryHealth(ctx, {
      serviceId: 'svc-1',
      deploymentId: 'curr-1',
      nodeId: 'node-1',
      trigger: 'crash_loop',
    })
    assert.equal(resAgain.action, 'skipped')
    assert.equal(resAgain.reason, 'already_handled')
  })
})
