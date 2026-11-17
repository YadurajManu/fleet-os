import { z } from 'zod'
import { ApiError } from '../api/errors.js'

export const DATABASE_CAPABILITIES = [
  'database.runtime.v1',
  'database.tcp.v1',
  'database.exec.v1',
  'database.backup.v1',
  'database.metrics.v1',
] as const

export const databaseCapabilities = z
  .array(
    z
      .string()
      .max(64)
      .regex(/^database\.[a-z][a-z0-9_.-]*\.v[1-9][0-9]*$/),
  )
  .max(32)
  .default([])

export function requireDatabaseCapabilities(
  reported: readonly string[] | null | undefined,
  required: readonly (typeof DATABASE_CAPABILITIES)[number][],
): void {
  const missing = required.filter((value) => !reported?.includes(value))
  if (missing.length)
    throw ApiError.conflict(
      'agent_upgrade_required',
      `Agent upgrade required: missing ${missing.join(', ')}. Upgrade the selected node with the Fleet agent installer, then retry.`,
    )
}
