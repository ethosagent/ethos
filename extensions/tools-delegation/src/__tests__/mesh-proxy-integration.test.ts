// Mesh-proxy end-to-end reconciliation — the two sides wired together for real.
//
// Two REAL SQLiteJobStore instances stand in for two agents:
//   - storeB: the peer that actually runs the job.
//   - storeA: the caller, holding a PROXY row (remotePeer/remoteJobId set) that
//     mirrors what `route_to_agent(background:true)` creates on a mesh spawn.
// The HTTP boundary is faked in-process by a fetchImpl that answers B's `/rpc`
// `job_status` method out of storeB — its response shape is copied verbatim from
// the real acp-server handler (apps/acp-server/src/index.ts `job_status` case).
// No real network, no real timers: sweepOnce() is driven directly.

import { SQLiteJobStore } from '@ethosagent/job-store';
import { describe, expect, it } from 'vitest';
import { MeshProxyReconciler } from '../mesh-reconciler';

/** Emulate acp-server's `job_status` JSON-RPC method, served out of `storeB`. */
function makePeerFetch(storeB: SQLiteJobStore) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      params?: { jobId?: string };
    };
    const jobId = body.params?.jobId ?? '';
    const job = await storeB.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { found: false } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          found: true,
          status: job.status,
          summary: job.summary ?? null,
          error: job.error ?? null,
          spendUsd: job.spendUsd,
        },
      }),
      { status: 200 },
    );
  };
}

describe('mesh proxy reconciliation (real stores, in-process peer)', () => {
  it('mirrors a peer job running -> done onto the local proxy row', async () => {
    // Peer B: a real job, claimed running.
    const storeB = new SQLiteJobStore(':memory:');
    const jobB = await storeB.create({
      owner: 'B',
      parentSessionKey: 'acp:x',
      rootSessionKey: 'acp:x',
      childSessionKey: 'acp:x:job',
      depth: 0,
      prompt: 'do it',
    });
    await storeB.claimNextQueued('B');

    // Caller A: a proxy row pointing at B's job, claimed running locally.
    const storeA = new SQLiteJobStore(':memory:');
    const proxy = await storeA.create({
      owner: 'mesh-proxy:1',
      parentSessionKey: 'cli:a',
      rootSessionKey: 'cli:a',
      childSessionKey: 'cli:a:mesh',
      depth: 1,
      prompt: 'do it',
      remotePeer: '127.0.0.1:9',
      remoteJobId: jobB.id,
    });
    await storeA.claimNextQueued('mesh-proxy:1');

    const reconciler = new MeshProxyReconciler({
      store: storeA,
      fetchImpl: makePeerFetch(storeB),
      missThreshold: 3,
    });

    // B is still running; give it some spend, then sweep.
    await storeB.updateSpend(jobB.id, 0.25);
    await reconciler.sweepOnce();

    let mirrored = await storeA.get(proxy.id);
    expect(mirrored?.status).toBe('running');
    expect(mirrored?.spendUsd).toBe(0.25);
    expect(typeof mirrored?.heartbeatAt).toBe('number'); // heartbeated while alive

    // B finishes; the next sweep mirrors done + summary onto A.
    await storeB.finish(jobB.id, 'done', { summary: 'the answer' });
    await reconciler.sweepOnce();

    mirrored = await storeA.get(proxy.id);
    expect(mirrored?.status).toBe('done');
    expect(mirrored?.summary).toBe('the answer');

    // A now has no running-remote rows left to poll.
    expect(await storeA.listRunningRemote()).toEqual([]);
  });

  it('fails the proxy after the peer stops answering (missThreshold), never heartbeating on a miss', async () => {
    const storeA = new SQLiteJobStore(':memory:');
    const proxy = await storeA.create({
      owner: 'mesh-proxy:2',
      parentSessionKey: 'cli:b',
      rootSessionKey: 'cli:b',
      childSessionKey: 'cli:b:mesh',
      depth: 1,
      prompt: 'do it',
      remotePeer: '127.0.0.1:9',
      remoteJobId: 'gone-forever',
    });
    await storeA.claimNextQueued('mesh-proxy:2');
    const claimedHeartbeat = (await storeA.get(proxy.id))?.heartbeatAt;

    const missThreshold = 3;
    const reconciler = new MeshProxyReconciler({
      store: storeA,
      fetchImpl: async () => {
        throw new Error('peer down');
      },
      missThreshold,
    });

    // Misses below the threshold: still running, and NOT heartbeated.
    for (let i = 0; i < missThreshold - 1; i++) {
      await reconciler.sweepOnce();
      const row = await storeA.get(proxy.id);
      expect(row?.status).toBe('running');
      expect(row?.heartbeatAt).toBe(claimedHeartbeat); // untouched on a miss
    }

    // The missThreshold-th miss fails the row.
    await reconciler.sweepOnce();
    const failed = await storeA.get(proxy.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('peer stopped answering job_status');
    expect(failed?.heartbeatAt).toBe(claimedHeartbeat); // never heartbeated across the misses
  });
});
