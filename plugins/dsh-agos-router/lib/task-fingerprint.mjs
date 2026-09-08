import { createHash } from 'node:crypto'

/** Shared by shadow and Fleet before redaction/truncation; evidence of task identity, not authorization. */
export function taskFingerprint(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  return createHash('sha256').update(text.trim()).digest('hex')
}
