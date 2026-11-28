import { EthosError, type InitiativeRow } from '@ethosagent/types';
import {
  decideInitiative,
  type InitiativeCliPort,
  type InitiativeDecideResult,
  type InitiativeDecision,
  renderBriefMarkdown,
} from '@ethosagent/wiring';

// `ethos initiatives` subcommands other than `run`: read the ledger, pause/resume through
// InitiativeConfigService (the only writer of initiatives/*.yaml) and record Gate 1, Gate 2 and
// self-start decisions through decideInitiative (wiring), which calls SQLiteInitiativeStore.recordDecision.

/** The decider the CLI records; web and chat surfaces record `owner_ui` / `owner_chat`. */
export const CLI_DECIDER = 'owner:cli';

export const MANAGE_USAGE =
  'Usage: ethos initiatives (list | show <id> | export <EXP-id> | pause <id> | resume <id> | metrics | approve <EXP-id> | deny <EXP-id> | adopt <EXP-id> [--option X] | dig-deeper <EXP-id> | park <EXP-id> | keep <id> | stop <id> | make-mine <id>) [--personality <id>] [--days N] [--json]';

export const MANAGE_COMMANDS: readonly string[] = [
  'list',
  'show',
  'export',
  'pause',
  'resume',
  'metrics',
  'approve',
  'deny',
  'adopt',
  'dig-deeper',
  'park',
  'keep',
  'stop',
  'make-mine',
];

export interface ManageOutput {
  /** Human lines (text mode). */
  lines: string[];
  /** The `--json` document body. */
  data: Record<string, unknown>;
  /** Raw stdout payload (export): printed as is, no trailing decoration. */
  raw?: string;
}

const invalid = (cause: string, action = MANAGE_USAGE): EthosError =>
  new EthosError({ code: 'INVALID_INPUT', cause, action });

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const v = args[at + 1];
  if (!v || v.startsWith('-')) throw invalid(`${name} needs a value`);
  return v;
}

/** The first positional (not a flag, not a flag's value). */
function positional(args: readonly string[]): string | undefined {
  const valued = new Set(['--personality', '--days', '--option']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valued.has(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Apply a decision through the shared wiring function; map its refusals to the CLI's typed errors. */
async function decide(
  port: InitiativeCliPort,
  d: InitiativeDecision,
  now: Date,
): Promise<Extract<InitiativeDecideResult, { ok: true }>> {
  const r = await decideInitiative(port, d, { decidedBy: CLI_DECIDER, now });
  if (r.ok) return r;
  if (r.kind === 'not_found') {
    throw new EthosError({
      code: 'NOT_FOUND',
      cause: r.message,
      action:
        d.gate === 'self_start'
          ? 'Check the id with "ethos initiatives list".'
          : 'Check the id with "ethos initiatives show <initiative-id>".',
    });
  }
  throw invalid(
    r.message,
    d.gate === 'self_start'
      ? 'keep / stop apply to agent-started initiatives awaiting your decision.'
      : r.kind === 'conflict'
        ? `This needs an exploration that is ${d.gate === 'gate1_explore' ? 'proposed' : 'briefed'}.`
        : 'Fix the file, then retry.',
  );
}

function requireInitiative(port: InitiativeCliPort, id: string): InitiativeRow {
  const row = port.store.getInitiative(id);
  if (!row)
    throw new EthosError({
      code: 'NOT_FOUND',
      cause: `initiative ${id} does not exist`,
      action: 'Check the id with "ethos initiatives list".',
    });
  return row;
}

const scalar = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : JSON.stringify(v);

export async function runManageCommand(
  args: readonly string[],
  port: InitiativeCliPort | null,
  opts: { personalityId: string; now?: Date },
): Promise<ManageOutput> {
  const [sub, ...rest] = args;
  if (!sub || !MANAGE_COMMANDS.includes(sub))
    throw invalid(sub ? `unknown subcommand "${sub}"` : 'missing subcommand');
  const now = opts.now ?? new Date();
  const personalityId = flag(rest, '--personality') ?? opts.personalityId;
  const need = (): InitiativeCliPort => {
    if (port === null) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: 'no initiatives saved yet',
        action: 'Create one in chat first.',
      });
    }
    return port;
  };
  if (port === null && sub === 'list') {
    return { lines: ['No initiatives saved.'], data: { initiatives: [] } };
  }
  const id = positional(rest);
  const needId = (): string => {
    if (!id) throw invalid(`${sub} needs an id`);
    return id;
  };

  switch (sub) {
    case 'list': {
      const rows = port ? port.store.list({ personalityId }) : [];
      const out: Array<InitiativeRow & { title: string }> = [];
      for (const r of rows) out.push({ ...r, title: (await port?.file(r.id))?.title ?? '' });
      const lines = out.map(
        (r) => `${r.id}  ${r.origin}  ${r.personalityId}  ${r.state}  ${r.title}`,
      );
      return {
        lines: lines.length
          ? ['id  origin  personality  state  title', ...lines]
          : ['No initiatives.'],
        data: { initiatives: out },
      };
    }
    case 'show': {
      const row = requireInitiative(need(), needId());
      const file = await need().file(row.id);
      const detail = need().store.get(row.id);
      const lines = [`${row.id}  ${row.origin}  ${row.state}  (personality ${row.personalityId})`];
      if (file) for (const [k, v] of Object.entries(file)) lines.push(`${k}: ${scalar(v)}`);
      else lines.push('(initiative file missing or invalid)');
      for (const e of detail?.explorations ?? [])
        lines.push(`exploration ${e.id}  ${e.state}  ${e.question}`);
      return { lines, data: { initiative: row, file, explorations: detail?.explorations ?? [] } };
    }
    case 'export': {
      const p = need();
      const e = p.store.getExploration(needId());
      if (!e)
        throw new EthosError({
          code: 'NOT_FOUND',
          cause: `exploration ${id} does not exist`,
          action: 'Check the id with "ethos initiatives show <initiative-id>".',
        });
      const briefs = (p.store.get(e.initiativeId)?.briefs ?? []).filter(
        (b) => b.explorationId === e.id,
      );
      const brief = briefs.reduce<(typeof briefs)[number] | undefined>(
        (a, b) => (!a || b.version > a.version ? b : a),
        undefined,
      );
      if (!brief)
        throw invalid(
          `${e.id} has no brief yet (it is ${e.state})`,
          'Export works on a briefed exploration.',
        );
      const findings = (p.store.get(e.initiativeId)?.findings ?? []).filter(
        (f) => f.explorationId === e.id,
      );
      const md = renderBriefMarkdown({
        question: e.question,
        bodyMd: brief.bodyMd,
        recommendedOption: brief.recommendedOption,
        findings,
      });
      return { lines: [], data: { explorationId: e.id, markdown: md }, raw: md };
    }
    case 'pause':
    case 'resume': {
      const p = need();
      const row = requireInitiative(p, needId());
      const r = await p.config.save({
        personalityId: row.personalityId,
        op: sub,
        draft: { id: row.id },
        sessionId: 'cli',
        confirmedBy: 'owner_ui', // the contract has no CLI value; the CLI is an owner surface
      });
      if (!r.ok) throw invalid(r.error, 'Nothing was changed.');
      return {
        lines: [`${row.id}: ${sub === 'pause' ? 'paused' : 'resumed'} (version ${r.version})`],
        data: { id: row.id, op: sub, version: r.version },
      };
    }
    case 'metrics': {
      const days = Number(flag(rest, '--days') ?? 30);
      if (!Number.isFinite(days) || days <= 0) throw invalid('--days must be a positive number');
      const since = new Date(now.getTime() - days * 86_400_000).toISOString();
      const m = port?.metrics(personalityId, since) ?? {
        gate1: { asked: 0, approved: 0, rate: 0 },
        gate2: { briefs: 0, adopted: 0, rate: 0 },
        selfStart: { started: 0, kept: 0, stopped: 0 },
      };
      let spent = 0;
      if (port) {
        for (const r of port.store.list({ personalityId })) {
          for (const w of port.store.windows(r.id)) if (w.started >= since) spent += w.spentUsd;
        }
      }
      const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
      return {
        lines: [
          `Last ${days} days (personality ${personalityId})`,
          `Gate 1 approve rate: ${pct(m.gate1.rate)} (${m.gate1.approved} of ${m.gate1.asked})`,
          `Gate 2 approve rate: ${pct(m.gate2.rate)} (${m.gate2.adopted} of ${m.gate2.briefs})`,
          `Self-start: ${m.selfStart.kept} kept, ${m.selfStart.stopped} stopped`,
          `Spend: $${spent.toFixed(4)}`,
        ],
        data: { personalityId, days, ...m, spentUsd: spent },
      };
    }
    case 'approve':
    case 'deny': {
      const verdict = sub === 'approve' ? 'approve' : 'reject';
      const r = await decide(need(), { target: needId(), gate: 'gate1_explore', verdict }, now);
      return {
        lines: [
          `${r.exploration?.id}: ${sub === 'approve' ? 'approved, now exploring' : 'denied'}`,
        ],
        data: { id: r.exploration?.id, verdict },
      };
    }
    case 'adopt':
    case 'park': {
      const option = sub === 'adopt' ? (flag(rest, '--option') ?? null) : null;
      const r = await decide(
        need(),
        { target: needId(), gate: 'gate2_adopt', verdict: sub, option },
        now,
      );
      return {
        lines: [
          `${r.exploration?.id}: ${sub === 'adopt' ? 'adopted' : 'parked'}${option ? ` (option ${option})` : ''}`,
        ],
        data: { id: r.exploration?.id, verdict: sub, option },
      };
    }
    case 'dig-deeper': {
      const r = await decide(
        need(),
        { target: needId(), gate: 'gate2_adopt', verdict: 'dig_deeper' },
        now,
      );
      const next = r.exploration;
      return {
        lines: [
          `${next?.id}: exploring again, budget $${next?.budgetUsd.toFixed(2)}, until ${next?.deadline}`,
        ],
        data: { id: next?.id, verdict: 'dig_deeper', exploration: next },
      };
    }
    case 'keep':
    case 'stop': {
      const r = await decide(need(), { target: needId(), gate: 'self_start', verdict: sub }, now);
      return {
        lines: [`${r.initiative?.id}: ${sub === 'keep' ? 'kept (active)' : 'stopped'}`],
        data: { id: r.initiative?.id, verdict: sub },
      };
    }
    default: {
      const r = await decide(
        need(),
        { target: needId(), gate: 'self_start', verdict: 'make_mine' },
        now,
      );
      const row = r.initiative;
      if (!row) throw invalid('make-mine returned no initiative');
      return {
        lines: [
          `Making ${row.id} yours rewrites its file: ask in chat ("make ${row.id} mine"), where you confirm the change.`,
        ],
        data: { id: row.id, hint: 'make-mine is confirmed in chat' },
      };
    }
  }
}
