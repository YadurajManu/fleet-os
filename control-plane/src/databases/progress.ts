import { setTimeout as delay } from 'node:timers/promises'
import type { AppContext } from '../api/context.js'
import { databaseOperationHistory, type DatabaseScope } from './operations.js'

/** Durable cursor-based source for the lifecycle API's SSE adapter. */
export async function* streamDatabaseProgress(
  ctx: Pick<AppContext, 'db' | 'config'>,
  scope: DatabaseScope,
  signal: AbortSignal,
  after = 0,
) {
  while (!signal.aborted) {
    const page = await databaseOperationHistory(ctx, scope, after)
    for (const event of page) {
      if (signal.aborted) return
      after = event.id
      yield event
    }
    if (page.length === 100) continue
    try {
      await delay(250, undefined, { signal })
    } catch {
      if (signal.aborted) return
      throw new Error('Database progress interrupted.')
    }
  }
}
