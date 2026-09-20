import { z } from 'zod'
export const OCI_PLATFORM = /^linux\/(amd64|arm64|arm\/v7)$/
export const buildEvent = z.object({
  type: z.enum(['build.ack', 'build.log', 'build.result', 'build.renew']),
  version: z.literal(1), job_id: z.string().uuid(), attempt: z.number().int().min(1).max(3),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']).optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  text: z.string().max(16384).optional(), error: z.string().max(4096).optional(),
})
export type BuildEvent = z.infer<typeof buildEvent>
export type BuildAssignment = {
  type: 'build.assign'; version: 1; job_id: string; attempt: number; platform: string
  source: { url: string; sha256: string }; dockerfile: string
  build_args?: Record<string, string>; secrets?: Record<string, string>
  registry_target: string; registry_username: string; registry_password: string
  timeout_ms: number; cpu: number; memory_bytes: number; disk_bytes: number
}
