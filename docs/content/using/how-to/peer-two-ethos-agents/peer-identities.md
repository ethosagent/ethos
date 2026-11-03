---
title: "Peer two Ethos agents over A2A: exchange fingerprints"
description: "Mint A2A identities, compare fingerprints out of band, add and enable peers"
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Mint an identity on each Ethos agent, compare fingerprints out of band, and enable each agent as the other's peer.

## Result

`ethos a2a peer list` shows the other agent as `enabled` on both sides, anchored to the fingerprint you confirmed.

## Prereqs

- Complete [part 1](../peer-two-ethos-agents.md): A2A enabled on both agents and `echo-bot` exposing the `echo-status` skill on Agent B.
- The two terminals from part 1, each with its own `ETHOS_STATE_DIR` exported (`/tmp/ethos-a` and `/tmp/ethos-b`).

## 5. Mint each agent's identity

Minting is automatic on first use: `ethos a2a identity` generates an Ed25519 keypair for the personality if none exists yet, then prints the shareable card. **Terminal B**:

```bash
ethos a2a identity --personality echo-bot
```

```
personality    echo-bot (echo-bot)
fingerprint    3f7a9c1e2b4d6f80
well-known     http://localhost:3001/.well-known/agent-card.json?personality=echo-bot
json-rpc       http://localhost:3001/a2a/echo-bot
auth           http://localhost:3001/a2a-auth/echo-bot
exposed skills echo-status
```

**Terminal A**, on the personality that will make the call (`caller`, forked the same way):

```bash
ethos personality fork engineer caller
ethos a2a identity --personality caller
```

```
personality    caller (caller)
fingerprint    9a1d4e7c0b3f5288
well-known     http://localhost:3000/.well-known/agent-card.json?personality=caller
json-rpc       http://localhost:3000/a2a/caller
auth           http://localhost:3000/a2a-auth/caller
exposed skills none
```

`caller` exposing nothing is fine — it only initiates calls, it never serves an inbound skill. Copy each fingerprint out of band (paste it into the other terminal, a chat message, however you'd hand someone a real secret) — this hex string is the entire trust anchor. The real fingerprints are longer than the examples above; use whatever your terminal printed.

## 6. Add and enable each peer

Peering is bidirectional: A2A checks the allowlist on both the receiving side (is this caller authorized?) and the sending side (am I allowed to call this peer?). Both agents need to add and enable the other.

**Terminal A** — add B, using B's real well-known URL and fingerprint from step 5:

```bash
ethos a2a peer add --personality caller --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot
```

Run without `--fingerprint` first — this previews the card without writing anything:

```
peer         echo-bot
fingerprint  3f7a9c1e2b4d6f80

Confirm this fingerprint out-of-band, then re-run to add the peer:
  ethos a2a peer add --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot --fingerprint 3f7a9c1e2b4d6f80
```

Confirm the printed fingerprint matches what B told you in step 5, then re-run with `--fingerprint`:

```bash
ethos a2a peer add --personality caller \
  --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot \
  --fingerprint 3f7a9c1e2b4d6f80
```

```
✓ echo-bot added (disabled, full access) — run ethos a2a peer enable 3f7a9c1e2b4d6f80 to activate.
```

Every peer is added disabled and full-access (`scope: ['*']`) — a peer's *reach* is bounded by which skills the personality exposes and by T0.2's turn-time tool narrowing, not by the allowlist grant. Enable it:

```bash
ethos a2a peer enable 3f7a9c1e2b4d6f80 --personality caller
```

```
✓ peer 3f7a9c1e2b4d6f80 enabled.
```

**Terminal B** — the same in reverse, adding `caller`'s URL and fingerprint from step 5:

```bash
ethos a2a peer add --personality echo-bot \
  --url http://localhost:3000/.well-known/agent-card.json?personality=caller \
  --fingerprint 9a1d4e7c0b3f5288
ethos a2a peer enable 9a1d4e7c0b3f5288 --personality echo-bot
```

Continue with [Send a message and read the audit trail](send-and-audit.md).

## Verify

- `ethos a2a peer list --personality caller` on A shows `echo-bot` as `enabled`; the mirror on B shows `caller` as `enabled`.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `fingerprint mismatch` on `peer add` | The `--fingerprint` you typed doesn't match what the URL actually serves — a typo, or `webBaseUrl` pointing at the wrong port so the card came from a different process than you think. | Re-run `peer add` without `--fingerprint` to preview the real value, and confirm `webBaseUrl` matches the port `ethos serve` is actually bound to. |
