import { DEFAULT_TOKENS } from '../index';
import { defaultSkin } from './default';
import { monoSkin } from './mono';
import { paperSkin } from './paper';
/** Three built-in skins ship with the engine. */
export const BUILTIN_SKINS = Object.freeze({
    default: defaultSkin,
    mono: monoSkin,
    paper: paperSkin,
});
export const BUILTIN_SKIN_NAMES = Object.freeze(Object.keys(BUILTIN_SKINS));
function isPlainObject(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/**
 * Deep-merge two plain-object trees. Arrays and primitives in `overrides`
 * replace the base value wholesale; nested objects merge key-by-key.
 * Exported for testing — internal use only.
 */
export function deepMerge(base, overrides) {
    if (!isPlainObject(base) || !isPlainObject(overrides)) {
        return (overrides ?? base);
    }
    const result = { ...base };
    for (const key of Object.keys(overrides)) {
        const baseValue = base[key];
        const overrideValue = overrides[key];
        if (overrideValue === undefined)
            continue;
        if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
            result[key] = deepMerge(baseValue, overrideValue);
        }
        else {
            result[key] = overrideValue;
        }
    }
    return result;
}
/**
 * Resolve a skin name against a registry, returning concrete `Tokens`.
 * Walks the `extends` chain bottom-up so child overrides win.
 *
 * Throws if the name (or any ancestor) is missing from the registry,
 * or if the chain contains a cycle.
 */
export function resolveSkin(base, registry, skinName) {
    const visited = new Set();
    function gather(name) {
        if (visited.has(name)) {
            throw new Error(`Skin extends cycle detected at "${name}"`);
        }
        visited.add(name);
        const skin = registry[name];
        if (!skin) {
            throw new Error(`Unknown skin: "${name}"`);
        }
        const parentOverrides = skin.extends ? gather(skin.extends) : {};
        return deepMerge(parentOverrides, skin.tokens);
    }
    const overrides = gather(skinName);
    return deepMerge(base, overrides);
}
/**
 * Convenience: resolve against `DEFAULT_TOKENS` + `BUILTIN_SKINS`. Used by
 * surface code that doesn't carry custom-skin state.
 */
export function resolveBuiltinSkin(skinName) {
    return resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, skinName);
}
export { defaultSkin, monoSkin, paperSkin };
