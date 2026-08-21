import { parseFleetTracePage } from './remote-run-model.ts'

export type RemoteTraceEvent =
  | { kind: 'event', value: Record<string, unknown> }
  | { kind: 'parse-error' }

/** Source-specific resume position. Consumers must treat the token as opaque. */
export interface RemoteTraceCursor {
  source: string
  token: unknown
}

export interface RemoteTraceCheckpoint {
  cursor: RemoteTraceCursor
  caughtUp: boolean
  notice?: 'trace-not-created'
}

export interface RemoteTraceBatch {
  reset: boolean
  events: readonly RemoteTraceEvent[]
}

export type RemoteTraceEventsListener = (batch: RemoteTraceBatch) => void

/**
 * One replaceable source of remote agent events. A file source resolves after
 * one page; a future stream may emit several batches before its checkpoint.
 */
export interface RemoteTraceSource {
  start(onEvents: RemoteTraceEventsListener, signal: AbortSignal): Promise<RemoteTraceCheckpoint>
  stop(): void
}

export type RemoteTraceSourceFactory = (host: string, runId: string) => RemoteTraceSource

export interface FileRemoteTraceSourceOptions {
  host: string
  runId: string
  fetchPage: (url: string, signal: AbortSignal) => Promise<unknown>
  maxLines?: number
}

function parseEventLine(line: string): RemoteTraceEvent {
  try {
    const value = JSON.parse(line) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('trace event must be an object')
    return { kind: 'event', value: value as Record<string, unknown> }
  } catch {
    return { kind: 'parse-error' }
  }
}

export function createFileRemoteTraceSource({
  host,
  runId,
  fetchPage,
  maxLines = 2_000,
}: FileRemoteTraceSourceOptions): RemoteTraceSource {
  if (host === '' || runId === '') throw new TypeError('file trace source requires host and runId')
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 2_000) {
    throw new TypeError('file trace source maxLines must be an integer from 1 to 2000')
  }

  let nextLine = 1
  let totalLines = 0
  let active: AbortController | undefined
  let generation = 0

  const stop = (): void => {
    generation += 1
    active?.abort()
    active = undefined
  }

  return {
    async start(onEvents, signal) {
      stop()
      const requestGeneration = ++generation
      const controller = new AbortController()
      active = controller
      const abort = (): void => controller.abort(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      const requestedLine = nextLine
      try {
        const query = new URLSearchParams({
          host,
          run: runId,
          from: String(requestedLine),
          max: String(maxLines),
        })
        const page = parseFleetTracePage(await fetchPage(`/api/fleet/trace?${query.toString()}`, controller.signal))
        if (controller.signal.aborted || requestGeneration !== generation) throw controller.signal.reason ?? new DOMException('aborted', 'AbortError')
        if (page.host !== host || (page.runId !== null && page.runId !== runId)) {
          throw new TypeError('fleet trace response target does not match the requested run')
        }
        if (page.from !== requestedLine) throw new TypeError('fleet trace response cursor does not match the requested position')

        if (page.truncated || page.total < page.from - 1) {
          nextLine = 1
          totalLines = page.total
          onEvents({ reset: true, events: [] })
          return {
            cursor: { source: 'file-lines', token: String(nextLine) },
            caughtUp: false,
            ...(page.notice === undefined ? {} : { notice: page.notice }),
          }
        }

        nextLine = page.nextFrom
        totalLines = page.total
        onEvents({ reset: false, events: page.lines.map(parseEventLine) })
        return {
          cursor: { source: 'file-lines', token: String(nextLine) },
          caughtUp: nextLine > totalLines,
          ...(page.notice === undefined ? {} : { notice: page.notice }),
        }
      } finally {
        signal.removeEventListener('abort', abort)
        if (active === controller) active = undefined
      }
    },
    stop,
  }
}
