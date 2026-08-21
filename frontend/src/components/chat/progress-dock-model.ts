export interface ProgressDockBatch {
  callId: string;
  label: string;
  done: number;
  failed: number;
  total: number;
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
