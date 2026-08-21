/** Clamp a replay position to [1,total]; invalid positions mean latest. */
export function clampReplayValue(value: number, total: number): number {
  if (total < 1) return 1;
  if (!Number.isFinite(value)) return total;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > total) return total;
  return rounded;
}
