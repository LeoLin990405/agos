/** Shim for @deepseek-ai/dsh-user-approval/types(P0 宽松版)。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
export type ApprovalRequestId = Branded<'approval-request-id'>
export type ApprovalOutcome = 'approved' | 'rejected' | 'cancelled' | (string & {})
