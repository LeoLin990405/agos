import assert from 'node:assert/strict'
import test from 'node:test'
import { createFileRemoteTraceSource, type RemoteTraceEvent } from './remote-trace-source.ts'

const page = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  host: 'leo-03',
  runId: 'r-1',
  file: 'r-1/.trace/s/session.jsonl',
  from: 1,
  nextFrom: 1,
  total: 0,
  truncated: false,
  lines: [],
  runs: [],
  ...overrides,
})

test('file source owns physical offsets and emits source-neutral events', async () => {
  const urls: string[] = []
  const replies = [
    page({
      from: 1, nextFrom: 4, total: 4,
      lines: [
        JSON.stringify({ type: 'session', version: 0, id: 's' }),
        '{bad-json',
        JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      ],
    }),
    page({
      from: 4, nextFrom: 5, total: 4,
      lines: [JSON.stringify({ type: 'turn/end', data: { turn: 1 } })],
    }),
  ]
  const source = createFileRemoteTraceSource({
    host: 'leo-03', runId: 'r-1',
    fetchPage: async (url) => { urls.push(url); return replies.shift() },
  })
  const events: RemoteTraceEvent[] = []
  const first = await source.start((batch) => events.push(...batch.events), new AbortController().signal)
  assert.equal(first.caughtUp, false)
  assert.deepEqual(events.map((event) => event.kind), ['event', 'parse-error', 'event'])
  assert.equal(new URL(urls[0] as string, 'http://local').searchParams.get('from'), '1')

  const second = await source.start((batch) => events.push(...batch.events), new AbortController().signal)
  assert.equal(second.caughtUp, true)
  assert.equal(second.cursor.source, 'file-lines')
  assert.equal(new URL(urls[1] as string, 'http://local').searchParams.get('from'), '4')
  assert.equal(events.length, 4)
})

test('file rotation resets its private cursor and the next read starts at line one', async () => {
  const requested: string[] = []
  const replies = [
    page({ from: 1, nextFrom: 2, total: 1, lines: [JSON.stringify({ type: 'session', id: 'old' })] }),
    page({ from: 2, nextFrom: 2, total: 0, truncated: true }),
    page({ from: 1, nextFrom: 2, total: 1, lines: [JSON.stringify({ type: 'session', id: 'new' })] }),
  ]
  const source = createFileRemoteTraceSource({
    host: 'leo-03', runId: 'r-1',
    fetchPage: async (url) => { requested.push(new URL(url, 'http://local').searchParams.get('from') as string); return replies.shift() },
  })
  await source.start(() => {}, new AbortController().signal)
  const batches: { reset: boolean, events: readonly RemoteTraceEvent[] }[] = []
  const rotation = await source.start((batch) => batches.push(batch), new AbortController().signal)
  assert.equal(rotation.caughtUp, false)
  assert.deepEqual(batches, [{ reset: true, events: [] }])
  await source.start(() => {}, new AbortController().signal)
  assert.deepEqual(requested, ['1', '2', '1'])
})

test('stopping a source aborts its active read', async () => {
  let readSignal: AbortSignal | undefined
  const source = createFileRemoteTraceSource({
    host: 'leo-03', runId: 'r-1',
    fetchPage: async (_url, signal) => {
      readSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  })
  const pending = source.start(() => {}, new AbortController().signal)
  source.stop()
  await assert.rejects(pending, /aborted/)
  assert.equal(readSignal?.aborted, true)
})
