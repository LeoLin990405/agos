/** Shim for @deepseek-ai/dsh-attachment(P0 宽松版)。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
export type AttachmentIdType = Branded<'attachment-id'>
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | (string & {})
export interface ImageAttachmentLimits { maxBytes?: number; maxCount?: number }
export interface ImageAttachmentRef { id: AttachmentIdType; mediaType: ImageMediaType; name?: string }
