/** Same rule as the contract's SlugSchema (packages/web-contracts/src/schema/worlds.ts). */
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

export interface SlugList {
  slugs: string[];
  invalid: string[];
}

/** "ops, legal" -> slugs; anything that is not a slug is reported, not dropped. */
export function parseSlugList(text: string): SlugList {
  const items = [...new Set(text.split(/[,\s]+/).filter((x) => x.length > 0))];
  return { slugs: items.filter((x) => SLUG.test(x)), invalid: items.filter((x) => !SLUG.test(x)) };
}
