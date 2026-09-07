// Shared FuguNano allocation kernel. Ranking only — never live dispatch.
export const ALLOCATE_KAPPA = 4
export const ALLOCATE_UNLISTED_PRIOR = 0.15
export const ALLOCATE_SHORTLIST_K = 8
export const ALLOCATE_NOT_LIVE_COPY = '分配后验只排序，不接入 live dispatch'
export const ALLOCATE_POSTERIOR_COPY = '经验后验，不是模型推荐'
export const ALLOCATE_EXPOSURE_COPY = '短名单曝光不是胜负'

export function betaPrior(index, listSize) {
  return (listSize - index) / (listSize + 1)
}

export function posteriorMean(prior, evidence, kappa = ALLOCATE_KAPPA) {
  const s = Number(evidence && evidence.s) || 0
  const f = Number(evidence && evidence.f) || 0
  const a0 = kappa * prior + 1
  const b0 = kappa * (1 - prior) + 1
  return (a0 + s) / (a0 + s + b0 + f)
}

export function q6(x) {
  return Math.round(x * 1e6)
}
