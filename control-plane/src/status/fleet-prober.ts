import 'dotenv/config'
import { createContext, closeContext } from '../api/context.js'
import { loadConfig } from '../config.js'
import { probes, startProber } from './probes.js'
import { heartbeat, recordChecks } from './store.js'
import { evaluate, rollup } from './engine.js'

const ctx = createContext(loadConfig())
const stop = startProber(probes(ctx), async readings => { await recordChecks(ctx, readings); await evaluate(ctx, readings) }, () => heartbeat(ctx))
let rolling = false
const rollups = setInterval(() => { if (!rolling) { rolling = true; void rollup(ctx).catch(() => console.error('Status rollup failed')).finally(() => { rolling = false }) } }, 60000)
const keepAlive = setInterval(() => {}, 60000)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stop(); clearInterval(keepAlive); clearInterval(rollups); void closeContext(ctx).then(() => process.exit(0))
})
