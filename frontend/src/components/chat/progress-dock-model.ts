export interface ProgressDockBatch {
  callId: string;
  label: string;
  done: number;
  failed: number;
  total: number;
}

/** Flattened `/api/swarm/progress` call (`{ callId, ...body }`). */
export interface ProgressDockProgressCall {
  callId: string;
  description?: string;
  rows?: readonly Record<string, unknown>[];
}

/**
 * Dock view of a progress snapshot.
 * Keep unsettled batches, and settled ones that still have failures.
 * Fully successful settled batches stay off the dock (that is not a miss —
 * the miss was never seeing an in-flight row because the 10s store poll
 * skipped it; the subscribed dock now reads the same route on a shorter tick).
 */
export function deriveProgressDockFromCalls(
  calls: readonly ProgressDockProgressCall[] | undefined,
): ProgressDockSummary | undefined {
  if (calls === undefined || calls.length === 0) return undefined;
  const batches: ProgressDockBatch[] = [];
  for (const call of calls) {
    const rows = Array.isArray(call.rows) ? call.rows : [];
    if (rows.length === 0) continue;
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      const status = String(row['status'] ?? '');
      if (status === 'completed') done += 1;
      else if (status === 'failed') failed += 1;
    }
    if (done + failed >= rows.length && failed === 0) continue;
    const description = typeof call.description === 'string' ? call.description.trim() : '';
    batches.push({
      callId: call.callId,
      label: description !== '' ? description : call.callId,
      done,
      failed,
      total: rows.length,
    });
  }
  if (batches.length === 0) return undefined;
  let doneSum = 0;
  let totalSum = 0;
  for (const batch of batches) {
    doneSum += batch.done;
    totalSum += batch.total;
  }
  return { batches, done: doneSum, total: totalSum };
}

export interface ProgressDockSummary {
  batches: ProgressDockBatch[];
  done: number;
  total: number;
}

/** `summary={undefined}` is an intentional controlled empty state. */
export function hasControlledProgressSummary(props: object): boolean {
  return Object.prototype.hasOwnProperty.call(props, 'summary');
}
