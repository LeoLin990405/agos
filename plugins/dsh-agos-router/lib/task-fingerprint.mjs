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

/**
 * Public-safe form of a fingerprint. The raw sha256 of the *full task text* must
 * never be echoed into API responses: paired with a decision id it works as a
 * confirmation oracle for guessing the task behind a row (the algorithm is
 * public, so seeing the hash lets an attacker verify candidate task texts).
 * A 16-hex-char prefix is enough to correlate log lines, not enough to confirm
 * a guessed preimage.
 */
export function redactTaskFingerprint(value) {
  if (!isTaskFingerprint(value)) return null
  return `${value.slice(0, 16)}…`
}
