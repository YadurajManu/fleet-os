import { z } from 'zod'
import type { Config } from '../config.js'
import { inspectImage, pinnedImage } from '../build/manifests.js'
import { ApiError } from '../api/errors.js'
import { databaseEnginePlugin } from './engines.js'

const registry = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*$/,
  )
export function databaseImageTags(
  prefix: string,
  engine: string,
  version: string,
) {
  const plugin = databaseEnginePlugin(engine)
  if (!registry.safeParse(prefix).success || !plugin.versions.includes(version))
    throw ApiError.unprocessable(
      'invalid_database_image_catalog',
      'Set REGISTRY_URL to the private registry host/namespace and choose a supported engine version, then retry.',
    )
  return {
    primary: `${prefix}/fleet-databases/${engine}:${version}`,
    ...(engine === 'postgres'
      ? { pooler: `${prefix}/fleet-databases/pgbouncer:1` }
      : {}),
  }
}

/** Never fall back to a mutable tag or unverified architecture for stateful data. */
export async function resolveDatabaseImages(
  config: Pick<Config, 'REGISTRY_URL' | 'REGISTRY_CREDENTIALS'>,
  engine: string,
  version: string,
  platform: string,
) {
  if (!config.REGISTRY_URL)
    throw ApiError.unavailable(
      'database_images_unavailable',
      'The maintained database image catalog is not configured. Configure REGISTRY_URL and load verified database images before retrying.',
    )
  const plugin = databaseEnginePlugin(engine)
  if (!plugin.platforms.includes(platform))
    throw ApiError.unprocessable(
      'database_platform_unsupported',
      'Database images support linux/arm64 and linux/amd64. Select a compatible Linux-container node and retry.',
    )
  const tags = databaseImageTags(config.REGISTRY_URL, engine, version)
  try {
    const primary = await inspectImage(tags.primary, config)
    if (!primary.platforms.includes(platform))
      throw new Error('unsupported primary platform')
    if (tags.pooler) {
      const pooler = await inspectImage(tags.pooler, config)
      if (!pooler.platforms.includes(platform))
        throw new Error('unsupported pooler platform')
      return {
        primary: pinnedImage(tags.primary, primary.digest),
        pooler: pinnedImage(tags.pooler, pooler.digest),
      }
    }
    return { primary: pinnedImage(tags.primary, primary.digest) }
  } catch {
    throw ApiError.unavailable(
      'database_images_unavailable',
      'The maintained database image or required architecture is unavailable. Check private-registry access and load the verified image catalog, then retry.',
    )
  }
}
