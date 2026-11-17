import { useEffect, useRef, useState } from 'react'
import { ApiError, apiStream } from './api'

export type DatabaseView = {
  id: string
  fleetId: string
  project: string
  name: string
  engine: 'postgres' | 'redis'
  version: string
  mode: string
  status: string
  desiredState: string
  nodeId: string | null
  nodeName: string | null
  nodeStatus: string | null
  memoryMb: number
  cpu: number
  diskMb: number
  profile: string
  generation: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  purgeAfter: string | null
  warnings: string[]
  backupConfigured: boolean
}
export type DatabaseOperation = {
  id: string
  kind: string
  state: string
  progress: number
  errorCode: string | null
  createdAt: string
  finishedAt: string | null
}
export type DatabaseProgress = {
  id: number
  operationId: string
  kind: string
  state: string
  code: string
  progress: number
  createdAt: string
}
export type DatabaseCatalog = {
  engines: Array<{
    engine: 'postgres' | 'redis'
    versions: string[]
    modes: string[]
    profiles: string[]
  }>
}
export type DatabasePlacement = {
  outcome: 'placed' | 'no_eligible_node'
  nodeId?: string
  nodeName?: string
  summary?: string
  warnings: string[]
  candidates: Array<{
    nodeId: string
    nodeName: string
    freeRamMb: number
    freeDiskMb?: number
    reason?: string
    score: number
  }>
  rejected: Array<{
    nodeId: string
    nodeName: string
    code: string
    detail: string
  }>
}
export function databaseRequestKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}
export const databasePath = (fleetId: string, project: string, id?: string) =>
  `/fleets/${encodeURIComponent(fleetId)}/projects/${encodeURIComponent(project)}/databases${id ? `/${encodeURIComponent(id)}` : ''}`
export const databaseRoute = (database: Pick<DatabaseView, 'project' | 'id'>) =>
  `/databases/${encodeURIComponent(database.project)}/${database.id}`
export const operationActive = (operation: DatabaseOperation) =>
  ['queued', 'running', 'reconciling'].includes(operation.state)

/** Bounds partial events and ignores keepalives while accepting split UTF-8/CRLF input. */
export class DatabaseEventDecoder {
  private pending = ''
  push(text: string): DatabaseProgress[] {
    this.pending += text
    const frames = this.pending.split(/\r?\n\r?\n/)
    this.pending = frames.pop() ?? ''
    if (
      this.pending.length > 131072 ||
      frames.some((frame) => frame.length > 131072)
    )
      throw new Error('Progress event exceeds the supported size.')
    const events: DatabaseProgress[] = []
    for (const frame of frames) {
      let event = '',
        id = '',
        data = ''
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        if (line.startsWith('id:')) id = line.slice(3).trim()
        if (line.startsWith('data:')) data += `${line.slice(5).trimStart()}\n`
      }
      if (event !== 'progress') continue
      const value = JSON.parse(data) as DatabaseProgress
      if (
        !Number.isSafeInteger(value.id) ||
        value.id <= 0 ||
        String(value.id) !== id ||
        typeof value.operationId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          value.operationId,
        ) ||
        typeof value.state !== 'string' ||
        typeof value.kind !== 'string' ||
        typeof value.createdAt !== 'string' ||
        !Number.isInteger(value.progress) ||
        value.progress < 0 ||
        value.progress > 100 ||
        typeof value.code !== 'string'
      )
        throw new Error('Server returned an invalid progress event.')
      events.push(value)
    }
    return events
  }
}

export function useDatabaseEvents(
  path: string | null,
  onEvent: (event: DatabaseProgress) => void,
) {
  const callback = useRef(onEvent)
  callback.current = onEvent
  const [state, setState] = useState<
    'connecting' | 'live' | 'reconnecting' | 'unavailable'
  >('connecting')
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    let cursor = 0
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await apiStream(
            `${path}?after=${cursor}`,
            controller.signal,
          )
          const reader = response.body!.getReader(),
            decoder = new TextDecoder(),
            events = new DatabaseEventDecoder()
          setState('live')
          try {
            while (!controller.signal.aborted) {
              const next = await reader.read()
              if (next.done) break
              for (const event of events.push(
                decoder.decode(next.value, { stream: true }),
              )) {
                if (event.id <= cursor) continue
                cursor = event.id
                callback.current(event)
              }
            }
          } finally {
            await reader.cancel().catch(() => {})
          }
        } catch (error) {
          if (
            error instanceof ApiError &&
            [401, 403, 404].includes(error.status)
          ) {
            setState('unavailable')
            return
          }
        }
        if (controller.signal.aborted) return
        setState('reconnecting')
        await new Promise<void>((resolve) => {
          const finish = () => {
            window.clearTimeout(timer)
            controller.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = window.setTimeout(finish, 1500)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
      }
    }
    setState('connecting')
    void run()
    return () => controller.abort()
  }, [path])
  return state
}
