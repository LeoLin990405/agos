export interface FleetConsoleEntry {
  tab: 'fleet';
  fleetBatchId?: string;
}

/** Preserve the exact batch id selected in the dock; omit only an absent id. */
export function fleetConsoleEntry(batchId?: string): FleetConsoleEntry {
  return batchId === undefined ? { tab: 'fleet' } : { tab: 'fleet', fleetBatchId: batchId };
}
