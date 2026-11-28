import type {
  WorldChangeGroupSchema,
  WorldEntityEdgeSchema,
  WorldFactWireSchema,
  WorldGraphEdgeSchema,
  WorldGraphNodeSchema,
  WorldMountedBySchema,
  WorldProposalWireSchema,
  WorldSchemaWireSchema,
  WorldSummarySchema,
  WorldsConfigOutputSchema,
  WorldsEntityOutputSchema,
  WorldsSchemaOutputSchema,
  WorldTreeGroupSchema,
} from '@ethosagent/web-contracts';
import type { z } from 'zod';

// Wire shapes inferred from the contract schemas, so a component prop is the
// oRPC output type and never a hand-written copy.
export type WorldSummary = z.infer<typeof WorldSummarySchema>;
export type WorldMountedBy = z.infer<typeof WorldMountedBySchema>;
export type GraphNode = z.infer<typeof WorldGraphNodeSchema>;
export type GraphEdge = z.infer<typeof WorldGraphEdgeSchema>;
export type TreeGroup = z.infer<typeof WorldTreeGroupSchema>;
export type EntityDetail = z.infer<typeof WorldsEntityOutputSchema>;
export type EntityFact = z.infer<typeof WorldFactWireSchema>;
export type EntityEdge = z.infer<typeof WorldEntityEdgeSchema>;
export type ChangeGroup = z.infer<typeof WorldChangeGroupSchema>;
export type Proposal = z.infer<typeof WorldProposalWireSchema>;
export type WorldSchemaParsed = z.infer<typeof WorldSchemaWireSchema>;
export type SchemaState = z.infer<typeof WorldsSchemaOutputSchema>;
export type WorldConfig = z.infer<typeof WorldsConfigOutputSchema>;
