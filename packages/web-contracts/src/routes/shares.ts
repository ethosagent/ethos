import { oc } from '@orpc/contract';
import {
  ShareCreateInputSchema,
  ShareCreateOutputSchema,
  ShareListInputSchema,
  ShareListOutputSchema,
  SharePreviewInputSchema,
  SharePreviewOutputSchema,
  ShareRevokeInputSchema,
  ShareRevokeOutputSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Share links — cookie-only management of public read-only snapshots
// (plan/phases/share-links.md D12). See schema/shares.ts for the shapes.
// ---------------------------------------------------------------------------

/** @experimental */
export const shares = {
  preview: oc.input(SharePreviewInputSchema).output(SharePreviewOutputSchema),
  create: oc.input(ShareCreateInputSchema).output(ShareCreateOutputSchema),
  list: oc.input(ShareListInputSchema).output(ShareListOutputSchema),
  revoke: oc.input(ShareRevokeInputSchema).output(ShareRevokeOutputSchema),
};
