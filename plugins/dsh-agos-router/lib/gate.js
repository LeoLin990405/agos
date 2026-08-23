// Port of FuguNano engine/src/domain/gate.ts — pure go/no-go.

export const isGo = (result) => !result.checks.some((check) => check.severity === 'fail')

export const failures = (result) => result.checks.filter((check) => check.severity === 'fail')

export const warnings = (result) => result.checks.filter((check) => check.severity === 'warn')

export const mergeGates = (...results) => ({
  checks: results.flatMap((result) => result.checks),
})
