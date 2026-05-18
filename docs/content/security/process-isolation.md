---
title: Why run one process per personality in production?
description: Process-level isolation for Ethos personalities — when shared-process is safe, when to split, and the Kubernetes one-pod-per-personality pattern.
kind: explanation
audience: shared
slug: process-isolation
updated: 2026-05-18
---

Ethos runs multiple personalities inside a single gateway process by default. The gateway holds a `Map<botKey, AgentLoop>` — one loop per configured bot — and routes inbound messages to the right loop by platform, bot key, and chat ID. That design is simple, efficient, and correct for the majority of deployments.

But "correct" and "sufficient" are different questions. This page is about when to move from shared-process deployment to one-process-per-personality (or one-process-per-tenant), what you gain, what you pay, and how to wire it on Kubernetes.

## Context

The security model documented in [How does Ethos defend against the threats it knows about?](./overview.md) is built around per-personality boundaries enforced inside a single process. Three mechanisms do the heavy lifting:

- **`ScopedStorage`** decorates the `Storage` interface with a per-personality read/write path allowlist and a global always-deny floor for sensitive paths. A personality cannot read another personality's `MEMORY.md`, transcripts, or configuration directory. The cross-personality isolation test in `extensions/tools-file/src/__tests__/boundary.test.ts` codifies this as a regression property.

- **`DefaultToolRegistry`** enforces a hard toolset allowlist per personality. `toDefinitions(allowedTools)` filters the tool list the LLM sees, and `executeParallel` rejects calls outside the allowlist. A `researcher` personality cannot suddenly call `bash` because a skill told it to — the tool is not in its toolset, so the call never reaches the model.

- **`MemoryProvider`** routes every read and write through an opaque `scopeId`. Personalities with different scope IDs share nothing — different memory files, different search indexes, different sync targets.

Together, these give you strong logical isolation. Each personality operates within its own filesystem boundary, its own tool boundary, and its own memory scope, even though all three share an OS process, a V8 heap, and a set of file descriptors.

For most single-operator deployments — one person running a few personalities on a personal server or a small team VM — that is the right trade. The simplicity of a single process (one Docker image, one set of logs, one health check) outweighs the marginal safety gain of OS-level separation between personalities that all trust the same operator.

## Discussion

### When shared-process deployment is the right choice

The shared-process model is sufficient when all of the following hold:

- **Single operator.** One person (or one team with shared trust) controls the `~/.ethos/` profile, the API keys, and the `config.yaml`. The [single-operator-per-gateway assumption](./threat-model.md) is satisfied trivially.

- **Uniform trust level.** Every personality in the gateway has roughly the same security posture. A `researcher` with network access and an `engineer` with filesystem access are fine together — they serve the same operator and neither is more privileged than the other in a way that matters.

- **No compliance boundary.** There is no regulatory or contractual requirement to isolate one personality's data from another's at the OS or infrastructure level. The logical boundaries (`ScopedStorage`, toolset enforcement, scoped memory) are sufficient for the data-handling policy.

- **Shared resource tolerance.** If one personality enters a tight loop or consumes excessive memory, the operator accepts that the other personalities in the same process are affected. The [watcher](./controls.md#watcher) catches runaway loops and terminates turns, but it cannot prevent a V8 heap exhaustion caused by a single large tool result.

In this regime, the gateway's multi-bot routing (`Map<botKey, AgentLoop>`) handles everything. Each personality gets its own agent loop, its own scoped storage, its own toolset — and they all live in one process that is straightforward to deploy, monitor, and debug.

### When to split into separate processes

Split when any of the following become true. Each is a signal that the logical boundaries inside the process are no longer sufficient for the trust model you need.

**Different trust levels between personalities.** If one personality has `bash` in its toolset and another does not, the security posture of the two is materially different. A bug in the shared process — a V8 exploit, a native-module vulnerability, a file descriptor leak — could let the less-privileged personality inherit capabilities from the more-privileged one. Process separation means the `bash`-capable personality runs in its own address space with its own OS-level permissions; a compromise of the other process gains nothing.

**Multi-tenant workloads.** If different paying customers, business units, or compliance domains share a single Ethos deployment, the [single-operator-per-gateway assumption](./threat-model.md) no longer holds. Each tenant needs its own `~/.ethos/` profile, its own API keys, its own audit substrate. Running them in the same process — even with separate `ScopedStorage` instances — means they share a heap, share file descriptors, and share the failure domain of a single `node` process. Process-per-tenant restores the isolation property the threat model requires.

Multi-tenancy is a future direction for Ethos, not active work. The framework today is designed for single-operator deployments. The process-per-tenant pattern described here is the deployment-time answer for teams that need tenant isolation before the framework ships native multi-tenancy primitives.

**Compliance requirements for data isolation.** Some regulatory regimes (SOC 2 Type II, HIPAA, certain financial-services frameworks) require demonstrable process-level or container-level isolation between workloads that handle different data classifications. Logical isolation via `ScopedStorage` is strong, but an auditor may require evidence that the isolation boundary is enforced by the OS kernel, not by application code. Separate processes — each in its own container, with its own filesystem namespace — provide that evidence.

**Resource isolation.** A personality that processes large documents, runs long `bash` sessions, or makes many concurrent tool calls can exhaust the V8 heap or saturate the event loop. In a shared process, every other personality stalls. In separate processes, the resource-hungry personality hits its own container's memory limit and is OOM-killed without affecting the others. Kubernetes resource requests and limits give you per-pod controls that do not exist at the per-`AgentLoop` level inside a single process.

### The pattern: one Kubernetes pod per personality

The deployment pattern is straightforward. Every personality runs in its own pod, using the same Docker image with a different environment variable.

```
┌─────────────────────────────────────────────────┐
│  Kubernetes cluster                             │
│                                                 │
│  ┌─────────────┐  ┌─────────────┐              │
│  │ Pod: eng     │  │ Pod: research│              │
│  │              │  │              │              │
│  │ ETHOS_       │  │ ETHOS_       │              │
│  │ PERSONALITY  │  │ PERSONALITY  │              │
│  │ = engineer   │  │ = researcher │              │
│  │              │  │              │              │
│  │ Volume:      │  │ Volume:      │              │
│  │ /ethos-data  │  │ /ethos-data  │              │
│  │ (PVC, own)   │  │ (PVC, own)   │              │
│  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                     │
│         └───────┬──────────┘                     │
│                 │                                │
│         ┌───────▼───────┐                        │
│         │ NetworkPolicy │                        │
│         │ + IAM roles   │                        │
│         └───────────────┘                        │
└─────────────────────────────────────────────────┘
```

Each pod gets:

- **The same Docker image.** Build once, deploy N times. The image contains the full Ethos runtime; the personality is selected at startup via the `ETHOS_PERSONALITY` environment variable.

- **Its own `~/.ethos/` volume.** A PersistentVolumeClaim per pod ensures that each personality's configuration, memory, transcripts, and `observability.db` are physically separate. No shared filesystem means no shared state — `ScopedStorage` boundaries are reinforced by the volume boundary.

- **Its own resource limits.** Kubernetes `resources.requests` and `resources.limits` on CPU and memory give each personality a guaranteed allocation and a hard ceiling. An OOM in one pod does not cascade.

- **Its own network policy.** A Kubernetes `NetworkPolicy` scoped to the pod's labels can restrict egress per personality. The `researcher` pod might be allowed to reach the public internet; the `engineer` pod might be restricted to the internal cluster network plus a specific set of API endpoints. This is the infrastructure-level counterpart to Ethos's per-personality `networkReach` configuration — the two compose, they do not replace each other.

- **Its own IAM identity.** On AWS (via IRSA or EKS Pod Identity), GCP (via Workload Identity), or Azure (via Workload Identity Federation), each pod can assume a different service account with different permissions. The `engineer` personality's pod gets write access to the deployment pipeline; the `researcher` personality's pod gets read-only access to the data warehouse. The IAM boundary is enforced by the cloud provider, not by application code.

### Wiring the pod

A minimal Kubernetes Deployment for a single personality:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ethos-engineer
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ethos
      personality: engineer
  template:
    metadata:
      labels:
        app: ethos
        personality: engineer
    spec:
      containers:
        - name: ethos
          image: your-registry/ethos:latest
          env:
            - name: ETHOS_PERSONALITY
              value: engineer
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ethos-secrets
                  key: anthropic-api-key
          volumeMounts:
            - name: ethos-data
              mountPath: /home/ethos/.ethos
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
      volumes:
        - name: ethos-data
          persistentVolumeClaim:
            claimName: ethos-engineer-data
```

Replicate this manifest per personality, changing the `personality` label, the `ETHOS_PERSONALITY` value, the PVC name, and the resource limits as needed. A Helm chart or Kustomize overlay that parameterizes the personality name is the natural next step — but the pattern is simple enough that a template loop in any deployment tool handles it.

### What the outer boundary provides that the inner boundary does not

The process-internal boundaries (`ScopedStorage`, `DefaultToolRegistry`, `MemoryProvider`) are application-level. They depend on the correctness of the Ethos runtime. If a bug in the tool registry lets a call through, or a bug in `ScopedStorage` fails to resolve a symlink, the boundary is breached within the process.

The process-external boundaries (separate PID namespace, separate filesystem namespace, separate network namespace, separate IAM identity) are enforced by the Linux kernel and the cloud provider's control plane. A bug in the Ethos runtime cannot escape them. The two layers compose: the inner boundary catches the common cases cheaply; the outer boundary catches the edge cases that survive a runtime bug.

This is the same defense-in-depth principle documented in the [security overview](./overview.md) — multiple independent layers, each one cheap, each one raising the cost of a successful attack. Process isolation is the outermost layer. It is not a replacement for the inner boundaries; it is a backstop.

### Scaling considerations

The one-pod-per-personality pattern scales linearly. Ten personalities means ten pods. For a team running three to five personalities, the overhead is negligible on any modern Kubernetes cluster. For a platform hosting hundreds of tenant personalities, the operational cost is real but well-understood — Kubernetes was designed for exactly this workload shape.

The per-pod overhead is:

- **Memory.** The Ethos Node.js process idles at roughly 80-120 MB RSS. Each additional personality adds one process at that baseline, plus whatever the personality's tools and in-flight LLM context consume.

- **CPU.** Idle pods consume near-zero CPU. Active pods spike during LLM round-trips (serialization, tool execution, watcher evaluation) but the work is I/O-bound, not compute-bound. The LLM provider's API is the bottleneck, not the local process.

- **Storage.** Each pod's PVC holds the personality's `~/.ethos/` directory — configuration, memory files, transcripts, and `observability.db`. For a typical personality, this is single-digit megabytes growing slowly over time.

- **Operational complexity.** More pods means more log streams, more health checks, more rolling updates. Standard Kubernetes tooling (Prometheus, Grafana, Fluentd/Loki) handles this without personality-specific configuration — every pod exposes the same metrics and log format.

## Trade-offs

### Shared-process is simpler and sufficient for most deployments

The majority of Ethos users run a single operator with a handful of personalities on a personal server or a developer machine. For them, the shared-process model is the right default. It is simpler to deploy (one process, one set of logs, one health check), simpler to debug (one set of environment variables, one `observability.db`), and the logical boundaries are strong enough for the trust model.

Splitting into separate processes adds operational cost that is not justified unless the trust model demands it. Do not split preemptively — split when you have a concrete reason from the list above.

### Process isolation does not replace application-level controls

Running each personality in its own pod does not make `ScopedStorage`, toolset enforcement, or the watcher optional. The application-level controls catch the common cases — a personality trying to read outside its `fs_reach`, a skill declaring tools outside the allowed set, a model in a runaway loop. The OS-level boundary is the backstop for the uncommon cases where application code has a bug. Disabling the inner controls because you trust the outer boundary is removing a layer from the defense-in-depth stack.

### Multi-tenancy is not yet a first-class framework concern

The process-per-tenant pattern described here is a deployment-time workaround for a framework that today assumes a single operator per gateway. It works, and it is the recommended approach for teams that need tenant isolation today. But it is a workaround — the framework does not yet provide tenant-aware routing, per-tenant API key management, per-tenant billing, or per-tenant audit partitioning within a single process. Those capabilities are a future direction. Until they land, the answer is: one process per tenant, one `~/.ethos/` profile per tenant, and the cluster's infrastructure provides the isolation that the framework does not.

### The cost is linear and predictable

Ten personalities means ten pods, ten PVCs, ten sets of resource limits. The cost scales linearly, not quadratically. There are no cross-pod coordination costs — each pod is independent, stateless except for its PVC, and communicates only with its configured channel adapters and LLM providers. This is the simplest possible scaling model, and it is the one Kubernetes is optimized for.

## See also

- [Security controls](./controls.md) — the catalogue of per-personality and global controls, including `ScopedStorage`, toolset enforcement, and network policy.
- [What is the threat model?](./threat-model.md) — the single-operator-per-gateway assumption and the in-scope vs. out-of-scope split.
- [Production hardening checklist](./production-hardening-checklist.md) — step-by-step checklist for hardening a deployment before production, including container and network settings.
- [How does Ethos defend against the threats it knows about?](./overview.md) — the defense-in-depth model and the runtime precedence diagram.
