import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import {
  databaseLinks,
  databaseCredentials,
  deployments,
  secrets,
  services,
  tenantDatabases,
} from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { openSecret, sealSecret } from '../lib/crypto.js'
import { databaseEnginePlugin, type EngineCredentials } from './engines.js'
import { loadDatabase } from './lifecycle.js'

const linkInput = z
  .object({
    serviceId: z.string().uuid(),
    role: z.enum(['app', 'readonly']).default('app'),
    as: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict()

export type DatabaseLinkInput = z.input<typeof linkInput>
type DbTransaction = Parameters<
  Parameters<AppContext['db']['transaction']>[0]
>[0]

function openCredentials(
  ctx: AppContext,
  rows: Array<typeof databaseCredentials.$inferSelect>,
): EngineCredentials {
  const values = {} as EngineCredentials
  for (const row of rows)
    values[row.role] = JSON.parse(
      openSecret(row.encryptedValue, ctx.config.SECRETS_MASTER_KEY),
    )
  if (!values.owner || !values.app || !values.readonly)
    throw ApiError.unavailable(
      'database_credentials_unavailable',
      'Database credentials cannot be loaded. Inspect the resource before retrying.',
    )
  return values
}

function linkEnvKeys(
  database: typeof tenantDatabases.$inferSelect,
  role: 'app' | 'readonly',
  credentials: EngineCredentials,
  prefix?: string,
) {
  const plugin = databaseEnginePlugin(database.engine)
  const options = {
    id: database.id,
    fleetId: database.fleetId,
    project: database.project,
    name: database.name,
    version: database.version,
    mode: database.mode,
    allocation: {
      memoryMb: database.memoryMb,
      diskMb: database.diskMb,
      profile: database.profile,
      storage: 'unknown' as const,
    },
    credentials,
    images: {
      primary: database.images.primary!,
      ...(database.images.pooler ? { pooler: database.images.pooler } : {}),
    },
    overrides: database.config,
  }
  const envKeys =
    database.engine === 'postgres'
      ? {
          [prefix ? `${prefix}_DATABASE_URL` : 'DATABASE_URL']:
            plugin.connection(options, role),
          [prefix ? `${prefix}_DIRECT_URL` : 'DIRECT_URL']: plugin.connection(
            options,
            'owner',
            true,
          ),
        }
      : {
          [prefix ? `${prefix}_REDIS_URL` : 'REDIS_URL']: plugin.connection(
            options,
            role,
          ),
        }
  return envKeys
}

async function refreshServicePreferences(tx: DbTransaction, serviceId: string) {
  const links = await tx
    .select({ nodeId: tenantDatabases.nodeId })
    .from(databaseLinks)
    .innerJoin(
      tenantDatabases,
      eq(tenantDatabases.id, databaseLinks.databaseId),
    )
    .where(eq(databaseLinks.serviceId, serviceId))
  await tx
    .update(services)
    .set({
      preferredNodeIds: [
        ...new Set(links.flatMap(({ nodeId }) => (nodeId ? [nodeId] : []))),
      ],
    })
    .where(eq(services.id, serviceId))
}

export async function listDatabaseLinks(
  ctx: AppContext,
  fleetId: string,
  project: string,
  databaseId: string,
) {
  const database = await loadDatabase(ctx, fleetId, project, databaseId)
  return ctx.db
    .select({
      serviceId: services.id,
      serviceName: services.name,
      role: databaseLinks.role,
      envKeys: databaseLinks.envKeys,
      appliedGeneration: databaseLinks.appliedGeneration,
      restartRequired: databaseLinks.restartRequired,
    })
    .from(databaseLinks)
    .innerJoin(services, eq(services.id, databaseLinks.serviceId))
    .where(eq(databaseLinks.databaseId, database.id))
    .orderBy(services.name)
}

export async function linkDatabase(
  ctx: AppContext,
  fleetId: string,
  project: string,
  databaseId: string,
  body: DatabaseLinkInput,
  actor: { orgId: string; userId: string },
) {
  const input = linkInput.parse(body)
  const database = await loadDatabase(ctx, fleetId, project, databaseId)
  if (database.deletedAt || database.status === 'deleting')
    throw ApiError.conflict(
      'database_deleting',
      'Restore the database before linking a service.',
    )
  if (!database.images.primary)
    throw ApiError.conflict(
      'database_image_identity_missing',
      'Reconcile the database image identity before linking a service.',
    )

  const [service] = await ctx.db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, input.serviceId),
        eq(services.fleetId, fleetId),
        eq(services.project, project),
      ),
    )
  if (!service) throw ApiError.notFound('Project service')

  const credentialRows = await ctx.db
    .select()
    .from(databaseCredentials)
    .where(
      and(
        eq(databaseCredentials.databaseId, database.id),
        eq(databaseCredentials.generation, database.generation),
      ),
    )
  const credentials = openCredentials(ctx, credentialRows)
  const link = await ctx.db.transaction(async (tx) => {
    const [lockedService] = await tx
      .select()
      .from(services)
      .where(eq(services.id, service.id))
      .for('update')
    if (
      !lockedService ||
      lockedService.fleetId !== fleetId ||
      lockedService.project !== project
    )
      throw ApiError.notFound('Project service')
    const [lockedDatabase] = await tx
      .select()
      .from(tenantDatabases)
      .where(eq(tenantDatabases.id, database.id))
      .for('update')
    if (
      !lockedDatabase ||
      lockedDatabase.generation !== database.generation ||
      lockedDatabase.fleetId !== fleetId ||
      lockedDatabase.project !== project ||
      lockedDatabase.deletedAt ||
      lockedDatabase.status === 'deleting'
    )
      throw ApiError.conflict(
        'database_generation_changed',
        'The database changed while the link was being created. Refresh and retry.',
      )

    const existing = await tx
      .select({ id: databaseLinks.id })
      .from(databaseLinks)
      .where(eq(databaseLinks.serviceId, service.id))
    const [same] = await tx
      .select({ id: databaseLinks.id })
      .from(databaseLinks)
      .where(
        and(
          eq(databaseLinks.databaseId, database.id),
          eq(databaseLinks.serviceId, service.id),
        ),
      )
    if (same)
      throw ApiError.conflict(
        'database_link_exists',
        'This service is already linked to the database.',
      )

    const namedPrefix = database.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    let envKeys = linkEnvKeys(
      database,
      input.role,
      credentials,
      input.as ?? (existing.length ? namedPrefix : undefined),
    )
    const collision = async (keys: string[]) => {
      if (keys.some((key) => key in lockedService.env)) return true
      const [secret] = await tx
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.fleetId, fleetId),
            eq(secrets.serviceId, service.id),
            inArray(secrets.key, keys),
          ),
        )
        .limit(1)
      return Boolean(secret)
    }
    if (
      !input.as &&
      existing.length === 0 &&
      (await collision(Object.keys(envKeys)))
    )
      envKeys = linkEnvKeys(database, input.role, credentials, namedPrefix)
    if (await collision(Object.keys(envKeys)))
      throw ApiError.conflict(
        'database_link_env_conflict',
        'A configured service environment variable or secret conflicts with the database link. Choose another --as prefix or rename the service value.',
      )

    const mergedEnv = { ...lockedService.env }
    const mergedRefs = new Set(lockedService.secretRefs)
    for (const [key, value] of Object.entries(envKeys)) {
      const secret = sealSecret(value, ctx.config.SECRETS_MASTER_KEY)
      await tx.insert(secrets).values({
        fleetId,
        serviceId: service.id,
        key,
        encryptedValue: secret,
      })
      mergedEnv[key] = `\u0024{secret:${key}}`
      mergedRefs.add(key)
    }
    const hasRunningDeployment = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, service.id),
          eq(deployments.status, 'running'),
        ),
      )
      .limit(1)
    const [created] = await tx
      .insert(databaseLinks)
      .values({
        databaseId: database.id,
        serviceId: service.id,
        role: input.role,
        envKeys: Object.fromEntries(
          Object.keys(envKeys).map((key) => [key, key]),
        ),
        appliedGeneration: 0,
        restartRequired: hasRunningDeployment.length > 0,
      })
      .returning()
    await tx
      .update(services)
      .set({ env: mergedEnv, secretRefs: [...mergedRefs] })
      .where(eq(services.id, service.id))
    await refreshServicePreferences(tx, service.id)
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'database.link',
      targetType: 'database',
      targetId: database.id,
      metadata: {
        project,
        serviceId: service.id,
        role: input.role,
        envKeys: Object.keys(envKeys),
      },
    })
    return created!
  })
  return {
    link: {
      serviceId: service.id,
      serviceName: service.name,
      role: link.role,
      envKeys: link.envKeys,
      restartRequired: link.restartRequired,
      appliedGeneration: link.appliedGeneration,
    },
  }
}

export async function unlinkDatabase(
  ctx: AppContext,
  fleetId: string,
  project: string,
  databaseId: string,
  serviceId: string,
  actor: { orgId: string; userId: string },
) {
  const database = await loadDatabase(ctx, fleetId, project, databaseId)
  return ctx.db.transaction(async (tx) => {
    const [service] = await tx
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, serviceId),
          eq(services.fleetId, fleetId),
          eq(services.project, project),
        ),
      )
      .for('update')
    if (!service) throw ApiError.notFound('Project service')
    const [link] = await tx
      .select()
      .from(databaseLinks)
      .where(
        and(
          eq(databaseLinks.databaseId, database.id),
          eq(databaseLinks.serviceId, serviceId),
        ),
      )
      .for('update')
    if (!link) throw ApiError.notFound('Database link')
    const runningDeployment = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.status, 'running'),
        ),
      )
      .limit(1)
    const env = { ...service.env }
    const keys = Object.keys(link.envKeys)
    for (const [envKey, secretKey] of Object.entries(link.envKeys)) {
      if (env[envKey] === `\u0024{secret:${secretKey}}`) delete env[envKey]
      await tx
        .delete(secrets)
        .where(
          and(
            eq(secrets.fleetId, fleetId),
            eq(secrets.serviceId, serviceId),
            eq(secrets.key, secretKey),
          ),
        )
    }
    await tx
      .update(services)
      .set({
        env,
        secretRefs: service.secretRefs.filter((key) => !keys.includes(key)),
      })
      .where(eq(services.id, serviceId))
    await tx.delete(databaseLinks).where(eq(databaseLinks.id, link.id))
    await refreshServicePreferences(tx, serviceId)
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'database.unlink',
      targetType: 'database',
      targetId: database.id,
      metadata: { project, serviceId, envKeys: keys },
    })
    return {
      serviceId,
      envKeys: keys,
      restartRequired: runningDeployment.length > 0,
    }
  })
}
