// 16px stroke icons for nav rows — DESIGN.md "Sidebar → Icons": every nav
// item carries a `stroke="currentColor"`, `strokeWidth="1.5"`, `fill="none"`
// SVG. Paths are the prototype's (`plan/prototypes/teams-as-a-scope/
// ethos-team-scope.html`, `ICONS`), one entry per DESIGN.md icon assignment
// used by the team, Library and workspace columns. Sized by the
// `.sidebar-nav-item svg` rule.

export type NavIconKey =
  | 'chat'
  | 'overview'
  | 'board'
  | 'outbox'
  | 'structure'
  | 'documents'
  | 'memory'
  | 'activity'
  | 'channels'
  | 'settings'
  | 'learning'
  | 'personalities'
  | 'recipes'
  | 'skills'
  | 'plugins'
  | 'mcp'
  | 'tasks'
  | 'platforms'
  | 'teams'
  | 'mesh'
  | 'dashboards'
  | 'batch'
  | 'eval'
  | 'admin'
  | 'cron'
  | 'sessions'
  | 'goals'
  | 'identity';

const PATHS: Record<NavIconKey, string> = {
  chat: 'M2 3h12v8H6l-3 3v-3H2z',
  overview: 'M2 8l6-5 6 5v6H2z',
  board: 'M2 2h3v12H2zM6.5 2h3v8h-3zM11 2h3v10h-3z',
  // A tray with the draft still above it — nothing has gone out yet.
  outbox: 'M2 9.5v4h12v-4M8 1.5v7M5 4.5L8 1.5l3 3',
  structure:
    'M10 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM5 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM15 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 5v3M8 8l-4 2M8 8l4 2',
  documents: 'M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13M6.5 8.5h3M6.5 11h3',
  memory:
    'M5 2c-2 0-3 1.5-3 3 0 1-1 2 0 3.5S3 12 5 12h1V2zM11 2c2 0 3 1.5 3 3 0 1 1 2 0 3.5S13 12 11 12h-1V2z',
  // A bar chart: three ascending vertical bars.
  activity: 'M3.5 13.5v-4M8 13.5v-7M12.5 13.5v-11',
  channels: 'M2 3h12v10H2zM2 5l6 4 6-4',
  settings:
    'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3',
  // An inbox tray: proposed changes land here and wait for a decision.
  learning: 'M2 9h3.5l1 2h3l1-2H14M2 9l1.5-6h9L14 9v5H2z',
  personalities: 'M10.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM3 14c0-2.8 2.2-5 5-5s5 2.2 5 5',
  // An open book.
  recipes:
    'M8 4C6.5 3 4.5 2.5 2 2.5v10c2.5 0 4.5.5 6 1.5 1.5-1 3.5-1.5 6-1.5v-10C11.5 2.5 9.5 3 8 4zM8 4v10',
  skills: 'M9 1.5L3 9h4.5L7 14.5 13 7H8.5z',
  plugins: 'M6 1.5v3M10 1.5v3M4 4.5h8v4a4 4 0 0 1-8 0zM8 12.5v2',
  mcp: 'M8 1.5l5.5 3.25v6.5L8 14.5l-5.5-3.25v-6.5zM8 8v6.5M8 8l5.5-3.25M8 8L2.5 4.75',
  // A checklist: two ticked rows.
  tasks: 'M2 4l1.25 1.25L5.5 3M2 10l1.25 1.25L5.5 9M8 4.25h6M8 10.25h6',
  platforms:
    'M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM1.5 8h13M8 1.5c1.8 1.8 2.7 4 2.7 6.5S9.8 12.7 8 14.5C6.2 12.7 5.3 10.5 5.3 8S6.2 3.3 8 1.5z',
  teams:
    'M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM1.5 13.5c0-2.2 1.8-4 4.5-4s4.5 1.8 4.5 4M12.5 5.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zM11.5 9.5c1.8.3 3 1.8 3 4',
  mesh: 'M5.5 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14.5 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM10 12.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM5.5 4h5M4.5 5.75l2.5 5M11.5 5.75l-2.5 5',
  // Panels of unequal height.
  dashboards: 'M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z',
  batch: 'M2 5.5h7v9H2zM4 5.5v-2h7v9H9M6 3.5v-2h7v9h-2',
  eval: 'M2 2h12v12H2zM5 8l2 2 4-4',
  // A shield.
  admin: 'M8 1.5l5.5 2v4c0 3.5-2.3 6-5.5 7-3.2-1-5.5-3.5-5.5-7v-4zM5.75 8l1.5 1.5 3-3',
  cron: 'M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM8 4.5V8l2.5 1.5',
  // A list with leading dots: zero-length segments the round cap draws as dots.
  sessions: 'M2.5 4h.01M2.5 8h.01M2.5 12h.01M5.5 4H14M5.5 8H14M5.5 12H14',
  // A target: two concentric circles.
  goals: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  // An ID card: a head-and-shoulders portrait beside two text lines.
  identity:
    'M1.5 3.5h13v9h-13zM7 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM3.25 10.5c.3-1 1.1-1.5 2.25-1.5s1.95.5 2.25 1.5M9.5 6.5h3M9.5 9h3',
};

export function NavIcon({ icon }: { icon: NavIconKey }) {
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[icon]} />
    </svg>
  );
}
