// Ledger identities.
//
// The defect being fixed: `asm-${Date.now()}` and `dsp-${Date.now()}` repeat whenever
// two records are minted in the same millisecond (two browser tabs, a retry, a script
// loop, two hosts sharing ~/.dsh). A repeated id silently merges two different records
// — the second trial's turns get attributed to the first trial's proposal — and nothing
// downstream can detect it afterwards. `dec-…` had 8 hex nibbles, which is better than
// nothing but still only 32 bits.
//
// Every id therefore gains a random tail. The leading epoch-ms stays for readability
// and for continuity with rows already on disk, but it is decoration: uniqueness now
// comes from the tail alone.
//
// ── Two tail encodings, and why ──────────────────────────────────────────────────
// `dec-` is internal to the plugin, so it takes a full 128-bit hex tail. It still
// matches /^dec-\d+-[a-f0-9]+$/i, which shadow.js (DEC_ID_RE) and sanitize.js
// (DECISION_ID) both pin, so shadow linking and ref sanitising are unaffected.
//
// `asm-` and `dsp-` are part of a published contract with the console. The frontend
// validates them with /^asm-\d{1,20}$/ and /^dsp-\d{1,20}$/
// (frontend/src/components/console/routes-assemble.ts), and postAssembleDispatch()
// *refuses to send the request at all* when the proposal id fails that test. A hex
// tail there would disable the trial button until a separate owner widened those
// regexes. So these two keep an all-digit shape and spend the 7 digits the existing
// 20-digit budget leaves: 13 digits of timestamp + 7 random digits.
//
// The resulting guarantee is weaker than `dec-` and is stated honestly rather than
// rounded up: two asm/dsp ids collide only if minted in the same millisecond *and*
// drawing the same 1-in-10,000,000 tail. That removes the "same millisecond ⇒ same
// id" certainty, which was the actual bug. See docs/…/wiring/C-wiring.md for the
// apply-ready frontend diff that would let these move to the full 128-bit tail too.
import { randomBytes, randomInt } from 'node:crypto'

export const ID_ENTROPY_BYTES = 16
/** Digits available after a 13-digit epoch-ms inside the frontend's 20-digit budget. */
export const NUMERIC_TAIL_DIGITS = 7
const TIMESTAMP_DIGITS = 13

export const DECISION_ID_PREFIX = 'dec'
export const ASSEMBLE_ID_PREFIX = 'asm'
export const DISPATCH_ID_PREFIX = 'dsp'

/** `dec-<ts>-<hex>`; the tail is absent on rows minted before it existed. */
const HEX_ID_RE = /^dec-(\d{1,20})(?:-([a-f0-9]{8,64}))?$/i
/** `asm-<digits>` / `dsp-<digits>`, exactly the shape the console already accepts. */
const NUMERIC_ID_RE = /^(asm|dsp)-(\d{1,20})$/

function numericTail() {
  return String(randomInt(0, 10 ** NUMERIC_TAIL_DIGITS)).padStart(NUMERIC_TAIL_DIGITS, '0')
}

function timestampOf(now) {
  const value = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now()
  return String(value)
}

export function mintDecisionId(now) {
  return `${DECISION_ID_PREFIX}-${timestampOf(now)}-${randomBytes(ID_ENTROPY_BYTES).toString('hex')}`
}

export function mintAssembleId(now) {
  return `${ASSEMBLE_ID_PREFIX}-${timestampOf(now)}${numericTail()}`
}

export function mintDispatchId(now) {
  return `${DISPATCH_ID_PREFIX}-${timestampOf(now)}${numericTail()}`
}

/**
 * Parse any ledger id, old or new; null if it is not one.
 * `legacy` marks a row minted before the random tail existed. Those stay readable and
 * foldable forever — refusing them would orphan the whole existing ledger — but no
 * caller may mint one.
 */
export function parseLedgerId(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()

  const hex = HEX_ID_RE.exec(text)
  if (hex) {
    return {
      prefix: DECISION_ID_PREFIX,
      ts: Number(hex[1]),
      entropy: hex[2] ?? '',
      entropyBits: hex[2] ? hex[2].length * 4 : 0,
      legacy: hex[2] === undefined,
    }
  }

  const numeric = NUMERIC_ID_RE.exec(text)
  if (!numeric) return null
  const digits = numeric[2]
  // Anything longer than a bare timestamp carries a tail; a bare one is pre-C2.
  const hasTail = digits.length > TIMESTAMP_DIGITS
  return {
    prefix: numeric[1],
    ts: Number(hasTail ? digits.slice(0, TIMESTAMP_DIGITS) : digits),
    entropy: hasTail ? digits.slice(TIMESTAMP_DIGITS) : '',
    // log2(10^n), floored: an honest count, not the digit count dressed up as bits.
    entropyBits: hasTail ? Math.floor(Math.log2(10 ** (digits.length - TIMESTAMP_DIGITS))) : 0,
    legacy: !hasTail,
  }
}

export function isLedgerId(value, prefix) {
  const parsed = parseLedgerId(value)
  if (!parsed) return false
  return prefix === undefined || parsed.prefix === prefix
}

/** True for ids that carry a random tail at all — i.e. that cannot repeat by clock alone. */
export function hasEntropyTail(value) {
  const parsed = parseLedgerId(value)
  return Boolean(parsed && !parsed.legacy && parsed.entropy.length > 0)
}

/** Honest strength of the random tail, in bits. 0 for legacy ids. */
export function entropyBitsOf(value) {
  return parseLedgerId(value)?.entropyBits ?? 0
}
