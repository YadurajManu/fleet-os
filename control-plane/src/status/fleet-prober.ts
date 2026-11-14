import 'dotenv/config'
import { createContext, closeContext } from '../api/context.js'
import { loadConfig } from '../config.js'
import { probes, startProber } from './probes.js'
import { heartbeat, recordChecks } from './store.js'

const ctx = createContext(loadConfig())
const stop = startProber(probes(ctx), readings => recordChecks(ctx, readings), () => heartbeat(ctx))
const keepAlive = setInterval(() => {}, 60000)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stop(); clearInterval(keepAlive); void closeContext(ctx).then(() => process.exit(0))
})
