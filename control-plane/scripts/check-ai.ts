import 'dotenv/config'
import { checkProvider } from '../src/ai/provider.js'
const { AI_BASE_URL: baseUrl, AI_API_KEY: apiKey, AI_MODEL: model } = process.env
if (!baseUrl || !apiKey || !model) {
  console.error('Set AI_BASE_URL, AI_API_KEY and AI_MODEL in the control-plane environment. No request was sent.')
  process.exitCode = 1
} else {
  try {
    const url = new URL(baseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a plain HTTP(S) API root without embedded credentials')
    console.log(JSON.stringify(await checkProvider({ baseUrl, apiKey, model }), null, 2))
  } catch (err) { console.error(err instanceof Error ? err.message : 'Provider check failed'); process.exitCode = 1 }
}
