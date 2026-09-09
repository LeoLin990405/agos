/**
 * Chunk-boundary-safe redaction for anything the harness writes to disk.
 *
 * The bug this replaces. The host's stdout arrives as arbitrary byte chunks;
 * the old path detected secrets against a growing accumulator but redacted and
 * wrote each chunk on its own. A token split across two chunks — say
 * `…?token=abc` in chunk N and `def…` in chunk N+1 — had its first half written
 * to the log BEFORE the accumulator ever held a complete token to match, so the
 * value was reconstructible by concatenating consecutive log lines. Redaction
 * that runs per chunk cannot see a match that does not exist yet in that chunk.
 *
 * The fix is to make emission, not detection, the thing that waits. Bytes are
 * only written once they are provably not part of an unfinished secret:
 *
 * - Every secret shape the harness redacts (`sk-…`, `?token=…`, `dsh-auth-…=…`,
 *   registered literal values such as the launch token and session cookie) is
 *   whitespace-free. So the trailing run of non-whitespace characters is held
 *   back: whatever follows the last whitespace could still grow into a match.
 * - `Bearer <token>` is the one shape with internal whitespace, so the hold
 *   point additionally backs off over a trailing `Bearer` and its separator.
 * - When whitespace finally arrives the held run is complete, redaction runs on
 *   it, and only then does it reach the file.
 * - `flush()` at stream end redacts and writes whatever is still held, so the
 *   tail of a log is never lost — but it is redacted on the way out.
 *
 * A partial token therefore never reaches the disk: not the first half, not a
 * single byte of it. The regression feeds a synthetic token one byte at a time
 * (the worst possible split) and reads the file back.
 *
 * Bounded exception, stated rather than hidden: a single unbroken non-
 * whitespace run longer than {@link MAX_HOLD} characters is force-flushed to
 * keep memory bounded. Only a secret longer than 8 KiB could straddle that cut,
 * and nothing in this harness (or in dsh) mints one — launch tokens and session
 * cookies are tens of bytes.
 */
import { StringDecoder } from 'node:string_decoder';

/**
 * Largest amount of not-yet-emitted text held while waiting for a boundary.
 * Comfortably larger than any credential; small enough to never matter.
 */
export const MAX_HOLD = 8192

/**
 * First index of `text` that may still be part of an unfinished secret.
 *
 * Everything before it can be redacted and written; everything from it onward
 * has to wait for more input (or for {@link createRedactingWriter}'s flush).
 * @param text - the buffered, not-yet-emitted text.
 * @returns the index to emit up to (exclusive).
 */
export function holdPoint(text) {
  let cut = text.length
  // The trailing non-whitespace run may still be growing into a secret.
  while (cut > 0 && !/\s/.test(text[cut - 1])) cut -= 1
  // `Bearer <token>` straddles a space, so a trailing `Bearer` plus its
  // separator has to be held too — otherwise the scheme name is emitted and
  // the token that follows is no longer recognisable as a bearer credential.
  let afterSpace = cut
  while (afterSpace > 0 && /[ \t]/.test(text[afterSpace - 1])) afterSpace -= 1
  let wordStart = afterSpace
  while (wordStart > 0 && /\S/.test(text[wordStart - 1])) wordStart -= 1
  if (/^bearer$/i.test(text.slice(wordStart, afterSpace))) cut = wordStart
  // Memory guard: never hold more than MAX_HOLD characters.
  return Math.max(0, Math.max(cut, text.length - MAX_HOLD))
}

/**
 * Wrap a sink so that only redacted, boundary-complete text ever reaches it.
 *
 * @param options.write - receives redacted text ready to persist.
 * @param options.redact - the redaction function (injected so the caller's
 *   registered-secret set is the live one at emit time, not at construction).
 * @param options.observe - optional hook called with each decoded chunk BEFORE
 *   anything is emitted, so a caller can register a newly discovered secret in
 *   time for it to be redacted out of that very chunk.
 * @returns the writer handle.
 */
export function createRedactingWriter({ write, redact, observe }) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let emitted = 0

  /** Emit everything currently safe to emit. */
  const drain = () => {
    const cut = holdPoint(pending)
    if (cut === 0) return
    const text = redact(pending.slice(0, cut))
    pending = pending.slice(cut)
    emitted += text.length
    write(text)
  }

  return {
    /**
     * Feed one raw chunk. Multi-byte characters split across chunks are
     * reassembled by the decoder, so a log line in Chinese cannot be corrupted
     * into mojibake by an unlucky boundary either.
     * @param chunk - Buffer or string as it came off the pipe.
     */
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (text === '') return
      observe?.(text)
      pending += text
      drain()
    },
    /** Emit the held tail, redacted. Safe to call more than once. */
    flush() {
      const tail = decoder.end()
      if (tail !== '') { observe?.(tail); pending += tail }
      if (pending === '') return
      const text = redact(pending)
      pending = ''
      emitted += text.length
      write(text)
    },
    /** How much text is being withheld right now (regression assertions). */
    heldLength() { return pending.length },
    /** Total redacted characters emitted so far. */
    emittedLength() { return emitted },
  }
}
