/**
 * Expand a packed `chunks` history record (SessionChunkRun) back into the exact
 * `assistant/chunk` delta events the fold already consumes on the live path.
 * Ported from the Host encoder's expandRow (packages/core/session/chunk-rows.ts)
 * so the fold stays untouched — a history page's packed run renders identically
 * to a live token stream.
 *
 * Wire shape (0.1.2): { type:'chunks', event:{ type:`chunkrow/<kind>`, seq, time,
 * data:{turn, step, index, dt:number[], texts?:string[], id?, name?, args?:string[]} } }.
 */

type DeltaChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }

/** One expanded assistant/chunk event (the same shape the live stream emits). */
export interface ExpandedChunkEvent {
  type: 'assistant/chunk'
  seq: number
  time: number
  data: { turn: number; step: number; chunk: DeltaChunk }
}

const KIND: Record<string, DeltaChunk['type']> = {
  'chunkrow/text-chunks': 'text-delta',
  'chunkrow/reasoning-chunks': 'reasoning-delta',
  'chunkrow/tool-call-chunks': 'tool-call-delta',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Expand one wire chunkrow event into its member assistant/chunk events, in
 * order. Returns [] on any malformed shape (a corrupt packed run is dropped
 * rather than crashing the transcript; live tokens still render).
 */
export function expandChunkRun(chunkEvent: unknown): ExpandedChunkEvent[] {
  if (!isRecord(chunkEvent)) return []
  const kind = KIND[String(chunkEvent['type'] ?? '')]
  if (kind === undefined) return []
  const seq0 = Number(chunkEvent['seq'])
  const time0 = Number(chunkEvent['time'])
  const data = chunkEvent['data']
  if (!Number.isFinite(seq0) || !Number.isFinite(time0) || !isRecord(data)) return []
  const turn = Number(data['turn'])
  const step = Number(data['step'])
  const index = Number(data['index'])
  const dt = Array.isArray(data['dt']) ? data['dt'] as number[] : []
  const members = kind === 'tool-call-delta'
    ? (Array.isArray(data['args']) ? data['args'] as string[] : [])
    : (Array.isArray(data['texts']) ? data['texts'] as string[] : [])
  const id = typeof data['id'] === 'string' ? data['id'] : ''
  const hasName = Object.hasOwn(data, 'name') && typeof data['name'] === 'string'
  const out: ExpandedChunkEvent[] = []
  let time = time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += Number(dt[k - 1] ?? 0)
    let chunk: DeltaChunk
    if (kind === 'tool-call-delta') {
      chunk = { type: 'tool-call-delta', index, id, ...(hasName ? { name: data['name'] as string } : {}), argumentsDelta: members[k] as string }
    } else {
      chunk = { type: kind, index, text: members[k] as string }
    }
    out.push({ type: 'assistant/chunk', seq: seq0 + k, time, data: { turn, step, chunk } })
  }
  return out
}
