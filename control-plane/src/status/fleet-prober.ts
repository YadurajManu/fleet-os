import 'dotenv/config'
import { createContext, closeContext } from '../api/context.js'
import { loadConfig } from '../config.js'
import { probes, startProber } from './probes.js'
import { heartbeat, recordChecks } from './store.js'
import { evaluate, rollup } from './engine.js'
import { standalone } from './standalone.js'
import { notifySubscribers } from './subscriptions.js'

if (process.env.STATUS_STANDALONE_PROBER === 'true') {
  const stop = await standalone()
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)) })
} else {
const ctx = createContext(loadConfig())
const stop = startProber(probes(ctx), async readings => { await recordChecks(ctx, readings); await evaluate(ctx, readings) }, () => heartbeat(ctx))
let rolling = false
const rollups = setInterval(() => { if (!rolling) { rolling = true; void rollup(ctx).then(() => notifySubscribers(ctx)).catch(() => console.error('Status rollup failed')).finally(() => { rolling = false }) } }, 60000)
const keepAlive = setInterval(() => {}, 60000)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stop(); clearInterval(keepAlive); clearInterval(rollups); void closeContext(ctx).then(() => process.exit(0))
})
}
