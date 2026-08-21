/** `undefined` 是实时模式；数值是用户明确停留的历史位置。 */
export type RemoteReplayLimit = number | undefined;

/**
 * 受控回放显示值。历史位置不会因 total 增长而改变；只有实时模式跟随最新。
 * total 下降（远端轨迹轮转/重建）时才收窄到当前真实边界。
 */
export function remoteReplayValue(limit: RemoteReplayLimit, total: number): number {
  if (!Number.isFinite(total) || total < 1) return 0;
  const safeTotal = Math.floor(total);
  if (limit === undefined) return safeTotal;
  if (!Number.isFinite(limit)) return safeTotal;
  return Math.max(1, Math.min(Math.floor(limit), safeTotal));
}

/** 轨迹回转后把历史锚点永久收窄；绝不把历史态变回实时态。 */
export function reconcileRemoteReplayLimit(
  limit: RemoteReplayLimit,
  total: number,
): RemoteReplayLimit {
  return limit === undefined ? undefined : remoteReplayValue(limit, total);
}
