import type { Registration } from './protocol';

/** Stable identity of a registration across restarts, for the drift diff. */
export function regKey(reg: Registration): string {
  switch (reg.kind) {
    case 'tool':
      return `tool:${reg.name}`;
    case 'hook':
      return `hook:${reg.model}:${reg.name}`;
    case 'injector':
    case 'filter':
    case 'evaluator':
    case 'route':
    case 'health_check':
    case 'extractor':
      return `${reg.kind}:${reg.index}`;
    case 'slash':
    case 'cli':
      return `${reg.kind}:${reg.name}`;
    case 'data_source':
      return `data_source:${reg.id}`;
    case 'personality':
    case 'oauth_profile':
    case 'page':
    case 'renderer':
      return `${reg.kind}:${JSON.stringify(reg.data).slice(0, 80)}`;
  }
}

/** `isAvailable` snapshots change on their own and are not drift. */
export function signature(reg: Registration): string {
  if (reg.kind === 'tool') {
    const { available: _available, ...rest } = reg;
    return JSON.stringify(rest);
  }
  return JSON.stringify(reg);
}

/** Keys whose registration was added, removed or changed between two activations. */
export function diffRegistrations(
  before: readonly Registration[],
  after: readonly Registration[],
): string[] {
  const a = new Map(before.map((r) => [regKey(r), signature(r)]));
  const b = new Map(after.map((r) => [regKey(r), signature(r)]));
  const changed: string[] = [];
  for (const [key, sig] of a) if (b.get(key) !== sig) changed.push(key);
  for (const key of b.keys()) if (!a.has(key)) changed.push(key);
  return changed;
}
