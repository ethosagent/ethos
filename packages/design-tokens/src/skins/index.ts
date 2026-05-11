import { DEFAULT_TOKENS, type Tokens } from '../index';
import { defaultSkin } from './default';
import { monoSkin } from './mono';
import { paperSkin } from './paper';

// Skin engine. A `Skin` is a named pack of token overrides — at most a
// deep-partial of `Tokens`. Resolution walks the `extends` chain (a skin
// can build on top of another), deep-merges, and returns concrete tokens.
//
// Built-in skins live as TS modules in this directory. Custom user skins
// at `~/.ethos/skins/<name>.yaml` are a Phase 2 follow-up; the engine is
// already shape-compatible with them — the loader just needs to parse
// yaml into the same `Skin` interface.

export type DeepPartial<T> = T extends object
  ? T extends ReadonlyArray<unknown>
    ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

export interface Skin {
  name: string;
  description: string;
  /** Base skin to inherit from. Defaults to `default` (the empty skin). */
  extends?: string;
  /** Sparse token overrides. Anything not specified inherits from the base. */
  tokens: DeepPartial<Tokens>;
}

export type SkinRegistry = Readonly<Record<string, Skin>>;

/** Three built-in skins ship with the engine. */
export const BUILTIN_SKINS: SkinRegistry = Object.freeze({
  default: defaultSkin,
  mono: monoSkin,
  paper: paperSkin,
});

export const BUILTIN_SKIN_NAMES: ReadonlyArray<string> = Object.freeze(Object.keys(BUILTIN_SKINS));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merge two plain-object trees. Arrays and primitives in `overrides`
 * replace the base value wholesale; nested objects merge key-by-key.
 * Exported for testing — internal use only.
 */
export function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return (overrides ?? base) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (overrides as Record<string, unknown>)[key];
    if (overrideValue === undefined) continue;
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue as DeepPartial<typeof baseValue>);
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
}

/**
 * Resolve a skin name against a registry, returning concrete `Tokens`.
 * Walks the `extends` chain bottom-up so child overrides win.
 *
 * Throws if the name (or any ancestor) is missing from the registry,
 * or if the chain contains a cycle.
 */
export function resolveSkin(base: Tokens, registry: SkinRegistry, skinName: string): Tokens {
  const visited = new Set<string>();

  function gather(name: string): DeepPartial<Tokens> {
    if (visited.has(name)) {
      throw new Error(`Skin extends cycle detected at "${name}"`);
    }
    visited.add(name);
    const skin = registry[name];
    if (!skin) {
      throw new Error(`Unknown skin: "${name}"`);
    }
    const parentOverrides = skin.extends ? gather(skin.extends) : ({} as DeepPartial<Tokens>);
    return deepMerge(
      parentOverrides as Tokens,
      skin.tokens as DeepPartial<Tokens>,
    ) as DeepPartial<Tokens>;
  }

  const overrides = gather(skinName);
  return deepMerge<Tokens>(base, overrides);
}

/**
 * Convenience: resolve against `DEFAULT_TOKENS` + `BUILTIN_SKINS`. Used by
 * surface code that doesn't carry custom-skin state.
 */
export function resolveBuiltinSkin(skinName: string): Tokens {
  return resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, skinName);
}

export { defaultSkin, monoSkin, paperSkin };
