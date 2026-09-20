import { buildTransferRoutes } from './build/transfers.js'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { ApiError } from './api/errors.js'
import { authRoutes } from './api/auth.routes.js'
import { agentRoutes } from './api/agent.routes.js'
import { fleetRoutes } from './api/fleets.routes.js'
import { webhookRoutes } from './api/webhooks.routes.js'
import { githubRoutes } from './api/github.routes.js'
import { installRoutes } from './api/install.routes.js'
import { serviceRoutes } from './api/services.routes.js'
import { secretRoutes } from './api/secrets.routes.js'
import { backupRoutes } from './api/backups.routes.js'
import { setupTunnelServer } from './tunnel/registry.js'
import { setupTerminalServer } from './tunnel/terminal.js'
import { registerLogStream } from './api/log-stream.js'
import type { AppContext } from './api/context.js'

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      redact: {
        // Tokens must never reach a log file, including on an error path.
        // `body.value` is the secret store's only input shape — a validation
        // error on PUT /secrets/:key would otherwise log the credential.
        paths: [
          'req.headers.authorization',
          'body.password',
          'body.refreshToken',
          'body.value',
          'body.manifest',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  })

  app.decorate('ctx', ctx)

  // Build contexts arrive as a gzipped tar. Fastify has no parser for that, and
  // without one the upload route sees an unsupported-media-type error instead
  // of its body. Kept as a raw Buffer: the route unpacks it with tar.
  app.addContentTypeParser('application/gzip', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body)
  )

  const isProd = ctx.config.NODE_ENV === 'production'
  const corsOrigin = ctx.config.PUBLIC_DASHBOARD_URL
    ?? (isProd ? undefined : 'http://localhost:5173')
  if (isProd && !corsOrigin) {
    app.log.warn('PUBLIC_DASHBOARD_URL not set in production — CORS will reject all cross-origin requests')
  }

  await app.register(cors, {
    origin: corsOrigin ?? false,
    credentials: true,
  })
  await app.register(cookie)
  await app.register(jwt, { secret: ctx.config.JWT_SECRET })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, detail: err.detail } })
    }
    const fastifyErr = err as { validation?: unknown; message?: string; statusCode?: number; code?: string }
    if (fastifyErr.validation) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: fastifyErr.message ?? 'Invalid request' } })
    }
    // Framework errors, such as an unsupported media type, are client errors.
    // Do not hide them behind a generic 500; callers need a useful correction.
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.code(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? 'invalid_request',
          message: fastifyErr.message ?? 'Invalid request',
        },
      })
    }
    req.log.error({ err }, 'unhandled error')
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: 'no_route', message: `No route for ${req.method} ${req.url}` },
    })
  )

  await app.register(authRoutes)
  await app.register(agentRoutes)
  await app.register(buildTransferRoutes)
  await app.register(fleetRoutes)
  await app.register(webhookRoutes)
  await app.register(githubRoutes)
  await app.register(installRoutes)
  await app.register(serviceRoutes)
  await app.register(secretRoutes)
  await app.register(backupRoutes)

  registerLogStream(app)

  setupTunnelServer(app, ctx, ctx.tunnels)
  setupTerminalServer(app, ctx, ctx.tunnels)

  return app
}
