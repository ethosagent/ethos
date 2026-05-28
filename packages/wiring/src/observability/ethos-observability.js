// EthosObservability — ethos's adapter onto the generic
// `@ethosagent/observability-sqlite` writer.
//
// Why this lives in `packages/wiring/`:
//   The library (`extensions/observability-sqlite/`) is vocabulary-agnostic
//   by design. Ethos vocabulary (event categories, trace kinds, the
//   personality-id↔subject-id mapping) lives in this thin adapter so the
//   library stays clean. Wiring is the integration layer: it constructs
//   ethos-specific things around generic primitives.
//
// Consumers (agent-loop, gateway, agent-mesh) accept their own minimal
// structural interface — never this concrete class — so individual
// packages don't pull in app vocabulary just to record events.
// EthosObservability satisfies those interfaces structurally at the
// wiring boundary.
//
// See: plan/phases/observability_extractability.md
// ---------------------------------------------------------------------------
// Ethos vocabulary — the only place these literals live in the codebase.
// Adding a new ethos event category MUST come with a corresponding typed
// helper below; the escape hatch (`recordEthosEvent`) is for one-offs only.
// ---------------------------------------------------------------------------
export const ETHOS_EVENT_CATEGORIES = [
    'error',
    'audit.transition',
    'audit.approval',
    'audit.block',
    'audit.watcher',
    'audit.injection_flag',
    'audit.redacted',
    'audit.compaction',
    'channel.pairing',
    'channel.allow',
    'channel.deny',
    'install.scan',
    'install.event',
    'tier.escalation',
    'tier.override',
];
export const ETHOS_TRACE_KINDS = [
    'turn',
    'mesh.handshake',
    'cron.tick',
    'channel.inbound',
    'system',
    'support.bundle',
];
// Frozen so callers that propagate the policy can't mutate the default
// out from under future calls.
const DEFAULT_REDACTION = Object.freeze({ level: 'redacted' });
/**
 * Domain-friendly facade over ObservabilityWriter. Owns ethos vocabulary;
 * translates ethos types to generic types at the boundary; exposes typed
 * helpers for common ethos events so call sites read as domain actions
 * rather than infrastructure plumbing.
 */
export class EthosObservability {
    writer;
    defaultRedaction;
    constructor(writer, defaultRedaction = DEFAULT_REDACTION) {
        this.writer = writer;
        this.defaultRedaction = defaultRedaction;
    }
    // ── Boundary translation ────────────────────────────────────────────────
    /** Map an ethos personality observability config to the generic policy. */
    redactionFor(obsConfig) {
        if (!obsConfig)
            return this.defaultRedaction;
        return {
            level: obsConfig.storeToolArgs ?? this.defaultRedaction.level,
            extraPatterns: obsConfig.redactPatterns,
        };
    }
    // ── Trace helpers (ethos vocabulary) ────────────────────────────────────
    startTurnTrace(opts) {
        return this.writer.startTrace({
            sessionId: opts.sessionId,
            kind: 'turn',
            subjectId: opts.personalityId,
            snapshotId: opts.snapshotId,
            attrs: opts.attrs,
            redaction: this.redactionFor(opts.obsConfig),
        });
    }
    startMeshHandshakeTrace(opts) {
        return this.writer.startTrace({
            sessionId: opts.sessionId,
            kind: 'mesh.handshake',
            subjectId: opts.personalityId,
            attrs: opts.attrs,
        });
    }
    startCronTrace(opts) {
        return this.writer.startTrace({
            sessionId: opts.sessionId,
            kind: 'cron.tick',
            subjectId: opts.personalityId,
            attrs: opts.attrs,
        });
    }
    startChannelInboundTrace(opts) {
        return this.writer.startTrace({
            sessionId: opts.sessionId,
            kind: 'channel.inbound',
            subjectId: opts.personalityId,
            attrs: opts.attrs,
        });
    }
    startSystemTrace(opts = {}) {
        return this.writer.startTrace({ kind: 'system', attrs: opts.attrs });
    }
    startSupportBundleTrace(opts = {}) {
        return this.writer.startTrace({ kind: 'support.bundle', attrs: opts.attrs });
    }
    endTrace(traceId, status) {
        this.writer.endTrace(traceId, status);
    }
    // ── Span passthrough (ethos has no domain spans yet) ────────────────────
    startSpan(opts) {
        return this.writer.startSpan({
            traceId: opts.traceId,
            parentSpanId: opts.parentSpanId,
            kind: opts.kind,
            name: opts.name,
            attrs: opts.attrs,
            redaction: opts.obsConfig ? this.redactionFor(opts.obsConfig) : undefined,
        });
    }
    endSpan(spanId, status, attrs) {
        this.writer.endSpan(spanId, status, attrs);
    }
    flush() {
        this.writer.flush();
    }
    // ── Typed event helpers ────────────────────────────────────────────────
    //
    // All helpers below funnel through `emit`. Adding a new ethos category is
    // one line: add to ETHOS_EVENT_CATEGORIES, then a one-line method here.
    emit(category, defaultSeverity, opts, extraDetails) {
        this.writer.recordEvent({
            traceId: opts.traceId,
            spanId: opts.spanId,
            category,
            severity: opts.severity ?? defaultSeverity,
            code: opts.code,
            cause: opts.cause,
            details: extraDetails === undefined ? opts.details : { ...(opts.details ?? {}), ...extraDetails },
        });
    }
    recordError(opts) {
        this.emit('error', 'error', opts);
    }
    recordSafetyTransition(opts) {
        this.emit('audit.transition', 'info', { traceId: opts.traceId }, {
            sessionId: opts.sessionId,
            fromPersonalityId: opts.fromPersonalityId,
            toPersonalityId: opts.toPersonalityId,
            fromSnapshotId: opts.fromSnapshotId,
            toSnapshotId: opts.toSnapshotId,
            trigger: opts.trigger,
        });
    }
    recordSafetyApproval(opts) {
        this.emit('audit.approval', 'info', opts, { decision: opts.decision });
    }
    recordSafetyBlock(opts) {
        this.emit('audit.block', 'warn', opts);
    }
    recordWatcherDecision(opts) {
        const severity = opts.severity ?? (opts.decision === 'terminate' ? 'critical' : 'warn');
        this.emit('audit.watcher', severity, { ...opts, severity }, { decision: opts.decision });
    }
    recordInjectionFlag(opts) {
        this.emit('audit.injection_flag', 'warn', opts);
    }
    recordRedacted(opts) {
        this.emit('audit.redacted', 'info', opts);
    }
    recordCompaction(opts) {
        this.emit('audit.compaction', 'info', opts);
    }
    recordChannelPairing(opts) {
        this.emit('channel.pairing', 'info', opts);
    }
    recordChannelAllow(opts) {
        this.emit('channel.allow', 'info', opts);
    }
    recordChannelDeny(opts) {
        this.emit('channel.deny', 'info', opts);
    }
    recordSkillScan(opts) {
        this.emit('install.scan', 'info', opts);
    }
    recordInstallEvent(opts) {
        this.emit('install.event', 'info', opts);
    }
    recordTierEscalation(opts) {
        this.emit('tier.escalation', 'info', opts, {
            from: opts.from,
            to: opts.to,
            reason: opts.reason,
            personalityId: opts.personalityId,
        });
    }
    recordTierOverride(opts) {
        this.emit('tier.override', 'info', opts, {
            actor: opts.actor,
            tier: opts.tier,
            personalityId: opts.personalityId,
        });
    }
    // ── Escape hatch ────────────────────────────────────────────────────────
    /**
     * For one-off events that don't deserve a typed helper. Recurring
     * categories should be promoted to a typed helper above.
     *
     * `category` is constrained to `EthosEventCategory` so a typo like
     * `'audit.tranistion'` fails typecheck.
     */
    recordEthosEvent(event) {
        this.writer.recordEvent(event);
    }
}
