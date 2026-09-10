/** Normalize a runner invocation and target one blocked scenario for retry. */
export function recoveryArgvForScenario(argv, scenarioId) {
  const normalized = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') { i += 1; continue }
    if (arg.startsWith('--only=')) continue
    normalized.push(arg)
  }
  if (typeof scenarioId === 'string' && scenarioId !== '') normalized.push('--only', scenarioId)
  return normalized
}
