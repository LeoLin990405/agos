// Port of FuguNano engine/src/domain/selector.ts — pure, no I/O.

export const DEFAULT_SELECTOR_CONFIG = {
  trustThreshold: 0.7,
  trustSingleton: false,
  forcedEscalateCategories: ['security', 'correctness', 'impossible'],
}

const escalate = (reason, agreementShare, confidence) => ({
  outcome: 'ESCALATE',
  reason,
  agreementShare,
  confidence,
})

export const smoothed = (k, n) => (k + 1) / (n + 2)

const clusterByLabel = (candidates) => {
  const clusters = new Map()
  for (const c of candidates) {
    if (c.label === undefined) continue
    const bucket = clusters.get(c.label)
    if (bucket) bucket.push(c.agent)
    else clusters.set(c.label, [c.agent])
  }
  return clusters
}

export const route = (candidates, config = DEFAULT_SELECTOR_CONFIG, taskCategory) => {
  if (candidates.length === 0) return escalate('empty', 0, 0)

  const verifiedPass = candidates.find((c) => c.verified === true)
  if (verifiedPass) {
    return {
      outcome: 'TRUST',
      pick: verifiedPass.agent,
      reason: 'gate-verified',
      agreementShare: 1,
      confidence: 1,
    }
  }
  const gateRan = candidates.some((c) => c.verified !== undefined)
  if (gateRan) return escalate('gate-failed', 0, 0)

  if (taskCategory !== undefined && config.forcedEscalateCategories.includes(taskCategory)) {
    return escalate('forced-category', 0, 0)
  }

  const clusters = clusterByLabel(candidates)
  const labeledTotal = [...clusters.values()].reduce((n, bucket) => n + bucket.length, 0)
  // 没有可聚的判断 ≠ 聚了但分裂。verified 剥掉后生产路径 labeledTotal 恒 0,
  // 再记 reason:'split' 就是给每条决策编一场没发生过的分歧(TASK-019 W2)。
  if (labeledTotal === 0) return escalate('no-signal', 0, 0)

  let dominant
  for (const bucket of clusters.values()) {
    const agent = bucket[0]
    if (agent === undefined) continue
    if (!dominant || bucket.length > dominant.size) dominant = { agent, size: bucket.length }
  }
  if (!dominant) return escalate('no-signal', 0, 0)

  const share = dominant.size / labeledTotal
  const confidence = smoothed(dominant.size, labeledTotal)

  if (labeledTotal === 1) {
    return config.trustSingleton
      ? {
          outcome: 'TRUST_SPOT_CHECK',
          pick: dominant.agent,
          reason: 'quorum',
          agreementShare: 1,
          confidence,
        }
      : escalate('singleton', 1, confidence)
  }

  return confidence >= config.trustThreshold
    ? {
        outcome: 'TRUST_SPOT_CHECK',
        pick: dominant.agent,
        reason: 'quorum',
        agreementShare: share,
        confidence,
      }
    : escalate('split', share, confidence)
}

export const escalationPriority = (decisions) => {
  const reasonRank = {
    'gate-failed': 0,
    'forced-category': 1,
    split: 2,
    'no-signal': 3,
    singleton: 4,
    empty: 5,
    quorum: 5,
    'gate-verified': 6,
  }
  return decisions
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.outcome === 'ESCALATE')
    .sort(
      (a, b) =>
        a.d.confidence - b.d.confidence ||
        reasonRank[a.d.reason] - reasonRank[b.d.reason] ||
        a.i - b.i,
    )
    .map(({ i }) => i)
}
