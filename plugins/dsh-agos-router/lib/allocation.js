// Port of FuguNano engine/src/domain/allocation.ts — types + defaults.
import { ALLOCATE_KAPPA, ALLOCATE_UNLISTED_PRIOR } from '../../dsh-agos/lib/allocate-kernel.js'

export const DEFAULT_ALLOCATION_PARAMS = {
  kappa: ALLOCATE_KAPPA,
  unlistedPrior: ALLOCATE_UNLISTED_PRIOR,
}

export const UNLISTED_RANK = Number.MAX_SAFE_INTEGER
