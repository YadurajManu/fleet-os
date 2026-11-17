import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../api/context.js'
import { ApiError } from '../api/errors.js'
import { databaseBackupTargets } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { sealSecret } from '../lib/crypto.js'

const endpoint = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  })

export const backupTargetInput = z
  .object({
    name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
    endpoint,
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    prefix: z
      .string()
      .max(512)
      .refine(
        (value) => !value.startsWith('/') && !value.split('/').includes('..'),
      )
      .default(''),
    region: z.string().min(1).max(128).default('us-east-1'),
    credentials: z
      .object({
        accessKeyId: z.string().min(1).max(256),
        secretAccessKey: z.string().min(1).max(4096),
        sessionToken: z.string().min(1).max(4096).optional(),
      })
      .strict(),
    isDefault: z.boolean().default(false),
  })
  .strict()

type TargetInput = z.output<typeof backupTargetInput>
const publicFields = {
  id: databaseBackupTargets.id,
  name: databaseBackupTargets.name,
  endpoint: databaseBackupTargets.endpoint,
  bucket: databaseBackupTargets.bucket,
  prefix: databaseBackupTargets.prefix,
  region: databaseBackupTargets.region,
  isDefault: databaseBackupTargets.isDefault,
  lastTestedAt: databaseBackupTargets.lastTestedAt,
  createdAt: databaseBackupTargets.createdAt,
}

export async function listBackupTargets(
  ctx: AppContext,
  fleetId: string,
  project: string,
) {
  return ctx.db
    .select(publicFields)
    .from(databaseBackupTargets)
    .where(
      and(
        eq(databaseBackupTargets.fleetId, fleetId),
        eq(databaseBackupTargets.project, project),
      ),
    )
    .orderBy(asc(databaseBackupTargets.name))
}

export async function createBackupTarget(
  ctx: AppContext,
  fleetId: string,
  project: string,
  input: TargetInput,
  actor: { orgId: string; userId: string },
) {
  return ctx.db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx
        .update(databaseBackupTargets)
        .set({ isDefault: false })
        .where(
          and(
            eq(databaseBackupTargets.fleetId, fleetId),
            eq(databaseBackupTargets.project, project),
            eq(databaseBackupTargets.isDefault, true),
          ),
        )
    }
    const [target] = await tx
      .insert(databaseBackupTargets)
      .values({
        fleetId,
        project,
        name: input.name,
        endpoint: input.endpoint,
        bucket: input.bucket,
        prefix: input.prefix,
        region: input.region,
        encryptedCredentials: sealSecret(
          JSON.stringify(input.credentials),
          ctx.config.SECRETS_MASTER_KEY,
        ),
        isDefault: input.isDefault,
      })
      .returning(publicFields)
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'database.backup_target.created',
      targetType: 'database_backup_target',
      targetId: target!.id,
      metadata: { name: target!.name, project, isDefault: target!.isDefault },
    })
    return target!
  })
}

export async function deleteBackupTarget(
  ctx: AppContext,
  fleetId: string,
  project: string,
  targetId: string,
  actor: { orgId: string; userId: string },
) {
  return ctx.db.transaction(async (tx) => {
    const [target] = await tx
      .delete(databaseBackupTargets)
      .where(
        and(
          eq(databaseBackupTargets.id, targetId),
          eq(databaseBackupTargets.fleetId, fleetId),
          eq(databaseBackupTargets.project, project),
        ),
      )
      .returning({
        id: databaseBackupTargets.id,
        name: databaseBackupTargets.name,
      })
    if (!target) throw ApiError.notFound('Backup target')
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'database.backup_target.deleted',
      targetType: 'database_backup_target',
      targetId: target.id,
      metadata: { name: target.name, project },
    })
    return target
  })
}
