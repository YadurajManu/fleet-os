import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { ApiError } from '../api/errors.js'
import { recordChecks, heartbeat } from './store.js'
import { evaluate } from './engine.js'
import type { Observation } from './probes.js'
export async function statusIngestRoutes(app: FastifyInstance) {
  app.post('/v1/status/ingest', { schema: {
    body: { type: 'object', required: ['id','observations'], additionalProperties: false, properties: {
      id: { type: 'string', format: 'uuid' }, observations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['component','ts','ok','latency_ms','status_code','error'], additionalProperties: false, properties: {
        component: { type: 'string', enum: ['api','postgres','redis','registry','ingress','tunnel','build','scheduler','logs','github-app','cli-auth','website','docs','dashboard','github','npm','docker-hub'] },
        ts: { type: 'string', format: 'date-time' }, ok: { type: ['boolean','null'] }, latency_ms: { type: ['number','null'], minimum: 0, maximum: 900000 }, status_code: { type: ['integer','null'], minimum: 100, maximum: 599 }, error: { type: ['string','null'], maxLength: 200 },
        metrics: { type: 'object', maxProperties: 20, additionalProperties: { type: 'number' } },
      } } },
    } }, response: { 202: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false } },
  }, preHandler: async req => {
    const expected = process.env.STATUS_INGEST_TOKEN; const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (!expected || expected.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw ApiError.unauthorized('Valid prober credential required')
  } }, async (req, reply) => {
    const b = req.body as { id: string; observations: Observation[] }
    if (b.observations.some(r => Date.parse(r.ts)>Date.now()+60000 || Date.parse(r.ts)<Date.now()-7*86400000)) throw ApiError.badRequest('invalid_timestamp','Observations must be within the last seven days.')
    const readings = b.observations.map(r => ({ ...r, error: r.ok === false ? 'Health check failed or timed out.' : null }))
    await app.ctx.sql.begin(async tx => {
      const inserted = await tx`insert into status_ingest_batches(id) values (${b.id}) on conflict do nothing returning id`
      if (inserted.length) await recordChecks({ ...app.ctx, sql: tx as unknown as typeof app.ctx.sql }, readings)
    })
    await evaluate(app.ctx, readings); await heartbeat(app.ctx)
    return reply.code(202).send({ accepted: true })
  })
}
