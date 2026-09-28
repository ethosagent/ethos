// A pending self-amendment planted on disk, for the tests that pin G2-1 (a):
// nothing that reads learning CANDIDATES — listing, replay, auto-promotion,
// promote, the inbox — may see, move or apply an amendment (plan
// personality-memory-boundary G2). Not a test file itself.

import type { AmendmentRecord, Storage } from '@ethosagent/types';
import { expect } from 'vitest';
import { applyOps } from '../amendment-ops';
import { createAmendment } from '../amendment-store';
import { amendmentProposalPath } from '../paths';
import { sha256Hex } from '../store';

export interface PlantedAmendment {
  record: AmendmentRecord;
  proposalPath: string;
  proposalBytes: string;
  toolsetPath: string;
  toolsetBytes: string;
}

/**
 * Write `<dataDir>/personalities/<personalityId>/toolset.yaml` and a PENDING
 * amendment adding `terminal` to it, filed against those bytes.
 */
export async function plantPendingAmendment(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<PlantedAmendment> {
  const toolsetPath = `${dataDir}/personalities/${personalityId}/toolset.yaml`;
  const toolsetBytes = '- read_file\n- propose_self_amendment\n';
  await storage.mkdir(`${dataDir}/personalities/${personalityId}`);
  await storage.write(toolsetPath, toolsetBytes);
  const ops = [{ op: 'add_tool' as const, tool: 'terminal' }];
  if (!applyOps(toolsetBytes, ops).ok) throw new Error('fixture ops must apply');
  const result = await createAmendment(storage, dataDir, {
    personalityId,
    ops,
    baseHash: sha256Hex(toolsetBytes),
    rationale: 'terminal was refused',
    evidence: [],
    provenance: {
      sessionId: 's-amend',
      sessionKey: 'cli:amend',
      platform: 'cli',
      initiator: 'user',
      roomAudience: 'private',
      executionPosture: 'docker',
      holdsShellTool: false,
    },
    preCheck: 'ok',
    status: 'pending',
  });
  if (result.kind !== 'created') throw new Error(`fixture amendment not created: ${result.kind}`);
  const proposalPath = amendmentProposalPath(dataDir, result.record.id);
  const proposalBytes = (await storage.read(proposalPath)) ?? '';
  return { record: result.record, proposalPath, proposalBytes, toolsetPath, toolsetBytes };
}

/** The amendment record and the live `toolset.yaml` are byte-for-byte what was planted. */
export async function expectAmendmentUntouched(
  storage: Storage,
  planted: PlantedAmendment,
): Promise<void> {
  expect(await storage.read(planted.proposalPath)).toBe(planted.proposalBytes);
  expect(await storage.read(planted.toolsetPath)).toBe(planted.toolsetBytes);
}
