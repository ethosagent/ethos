// The schema templates `ethos world create --template` seeds a new world from. The text lives in
// templates/<name>.schema.yaml (readable, reviewable); it is embedded here because this package is
// bundled for the CLI and must not read its own source tree at runtime (raw node:fs is banned in
// extensions, apps/ethos/src/__tests__/no-raw-fs.test.ts). Pinned byte-for-byte to the files by
// __tests__/templates.test.ts 'template text matches templates/<name>.schema.yaml'.

export type TemplateName = 'company' | 'watchlist';

export const TEMPLATE_NAMES: readonly TemplateName[] = ['company', 'watchlist'];

/** The audience a world made from the template starts with (plan open decision O-2). */
export const TEMPLATE_AUDIENCE: Record<TemplateName, 'owner_only' | 'shareable'> = {
  company: 'owner_only',
  watchlist: 'shareable',
};

const TEXT: Record<TemplateName, string> = {
  company:
    'version: 1\nentities:\n  Company: { attrs: { domain: { type: string } } }\n  Team:    { attrs: { mission: { type: string }, size: { type: int, min: 1 } } }\n  Person:  { attrs: { email: { type: string }, location: { type: string } } }\n  Skill:   { attrs: {} }\n  Service: { attrs: { repo: { type: url }, tier: { type: string } } }\nedges:\n  part_of:    "Team -> Company"\n  member_of:  { from: [Person], to: [Team], attrs: { role: { type: string }, since: { type: date } } }\n  reports_to: { from: [Person], to: [Person], unique: from }\n  expert_in:  { from: [Person], to: [Skill], attrs: { level: { type: int, min: 1, max: 5 } } }\n  owns:       { from: [Team, Person], to: [Service], unique: to }\n  depends_on: "Team -> Team"\n  mentors:    "Person -> Person"\n',
  watchlist:
    '# Stocks watchlist template (read-only research; nothing here places orders).\n# Default world audience for a watchlist is `shareable` (plan open decision\n# O-2, leaning column): a watchlist is expected to be shown to others, so the\n# agent proposes and the owner promotes. Set `private` in world config for a\n# personal list. The audience lives in the world config, not in this schema.\nversion: 1\nentities:\n  Stock:  { attrs: { ticker: { type: string }, exchange: { type: string } } }\n  Sector: { attrs: {} }\n  Event:  { attrs: { kind: { type: string }, date: { type: date }, url: { type: url } } }\n  List:   { attrs: {} }\nedges:\n  in_sector:     "Stock -> Sector"\n  supplies:      { from: [Stock], to: [Stock], attrs: { share: { type: number, min: 0, max: 1 } } }\n  competes_with: "Stock -> Stock"\n  affected_by:   { from: [Stock], to: [Event], attrs: { direction: { type: string, enum: [up, down, unclear] } } }\n  watched_in:    "Stock -> List"\n',
};

export function isTemplateName(s: string): s is TemplateName {
  return s === 'company' || s === 'watchlist';
}

/** The schema.yaml text of a template. */
export function loadTemplate(name: TemplateName): string {
  return TEXT[name];
}
