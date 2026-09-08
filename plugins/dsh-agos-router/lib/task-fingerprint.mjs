import { createHash } from 'node:crypto'

/**
 * Shared by shadow and Fleet before redaction/truncation; evidence of task identity, not authorization.
 *
 * Contract frozen: dsh-fleet/lib/fleet-ledger.mjs imports this and stamps every
 * dispatch event with it, and feedback-bind.mjs compares those hashes byte for
 * byte against shadow decision rows already on disk. Input normalisation (trim),
 * algorithm (sha256) and output (lowercase hex, or null for blank input) must not
 * change — anything else silently unbinds every historical row. Additions below
 * are read-only helpers over the same value.
 */
export function taskFingerprint(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  return createHash('sha256').update(text.trim()).digest('hex')
}

/** The on-disk shape of a fingerprint. feedback-bind.mjs pins the same pattern inline. */
export const TASK_FINGERPRINT_RE = /^[a-f0-9]{64}$/

export function isTaskFingerprint(value) {
  return typeof value === 'string' && TASK_FINGERPRINT_RE.test(value)
}

/** True when both sides carry a real fingerprint and they are the same task. */
export function sameTask(a, b) {
  return isTaskFingerprint(a) && isTaskFingerprint(b) && a === b
}
