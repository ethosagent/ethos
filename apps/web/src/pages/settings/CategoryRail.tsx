// The 240px navigation column. Three group headers, one row per category, the
// search field on top, active state read off the URL.
//
// Every number here is derived from `SETTINGS_INDEX` (D8). A hand-maintained
// count is a count that lies, and a rail that lies about how much a category
// holds is worse than a rail with no numbers at all.
//
// The status dot marks a category with unsaved changes IN IT — which is the
// point of deriving dirty state category-blind (D9): you can see that Voice is
// dirty while standing in Memory, and the save bar is telling you the same
// thing at the same time. Not a `Card` (DESIGN.md:134).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { countByCategory, filterSettings } from './lib/settings-index';
import { categoryHref, SETTINGS_GROUPS, type SettingsCategory } from './lib/taxonomy';
import { RailSearch } from './RailSearch';

/** Enough results to scan; beyond this the query is the thing to narrow. */
const MAX_RESULTS = 40;

export function CategoryRail({
  categories,
  activeCategory,
  dirtyCategories,
}: {
  categories: SettingsCategory[];
  activeCategory: string;
  /** Category slugs holding unsaved changes. */
  dirtyCategories: readonly string[];
}) {
  const [query, setQuery] = useState('');
  const counts = useMemo(() => countByCategory(), []);
  const visible = useMemo(() => new Set(categories.map((c) => c.slug)), [categories]);
  const results = useMemo(
    () => filterSettings(query).filter((e) => visible.has(e.category)),
    [query, visible],
  );
  const searching = query.trim().length > 0;

  // B6 (§6.4) — the operator categories fold behind one disclosure. The
  // toggle flips a CSS class ONLY (`.is-collapsed` → `display: none`): the
  // rows below stay mounted whatever it says, because the last toggle that
  // unmounted rendered two whole categories empty (components/advanced.tsx
  // carries that history). Standing IN an advanced category holds it open —
  // the active row must never be invisible.
  const advanced = categories.filter((c) => c.advanced);
  const activeIsAdvanced = advanced.some((c) => c.slug === activeCategory);
  const [advancedOpen, setAdvancedOpen] = useState(activeIsAdvanced);
  useEffect(() => {
    if (activeIsAdvanced) setAdvancedOpen(true);
  }, [activeIsAdvanced]);
  const advancedDirty = advanced.some((c) => dirtyCategories.includes(c.slug));

  const row = (category: SettingsCategory) => (
    <Link
      key={category.slug}
      to={categoryHref(category)}
      className={`settings-rail-row${category.slug === activeCategory ? ' active' : ''}`}
    >
      <span className="settings-rail-row-label">
        {category.label}
        {dirtyCategories.includes(category.slug) ? (
          <span
            className="settings-rail-dot"
            role="img"
            aria-label="unsaved changes"
            title="Unsaved changes"
          />
        ) : null}
      </span>
      <span className="settings-rail-count">{counts[category.slug] ?? 0}</span>
    </Link>
  );

  return (
    <nav className="settings-rail" aria-label="Settings categories">
      <RailSearch value={query} onChange={setQuery} />

      {searching ? (
        <SearchResults results={results} categories={categories} />
      ) : (
        <>
          {SETTINGS_GROUPS.map((group) => {
            const rows = categories.filter((c) => c.group === group && !c.advanced);
            if (rows.length === 0) return null;
            return (
              <div key={group} className="settings-rail-group">
                <div className="settings-rail-group-label">{group}</div>
                {rows.map(row)}
              </div>
            );
          })}

          {advanced.length > 0 ? (
            <>
              <button
                type="button"
                className="settings-rail-advanced-toggle"
                aria-expanded={advancedOpen}
                aria-controls="settings-rail-advanced"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen ? '▾' : '▸'} Advanced ({advanced.length}) —{' '}
                {advancedOpen ? 'hide' : 'show'} operator settings
                {!advancedOpen && advancedDirty ? (
                  <span
                    className="settings-rail-dot"
                    role="img"
                    aria-label="unsaved changes in a hidden category"
                    title="Unsaved changes in a hidden category"
                  />
                ) : null}
              </button>
              <div
                id="settings-rail-advanced"
                className={`settings-rail-group settings-rail-advanced${
                  advancedOpen ? '' : ' is-collapsed'
                }`}
              >
                {advanced.map(row)}
              </div>
            </>
          ) : null}
        </>
      )}
    </nav>
  );
}

/**
 * Search matches the whole index, dimmed rows included, whatever the advanced
 * toggle says (D10). The key is rendered because it is half of what was
 * searched: an operator who came here from `config.yaml` needs to see that the
 * row they found is the row that writes the key they read.
 */
function SearchResults({
  results,
  categories,
}: {
  results: ReturnType<typeof filterSettings>;
  categories: SettingsCategory[];
}) {
  if (results.length === 0) {
    return <div className="settings-rail-empty">No setting matches that.</div>;
  }
  const byCategory = new Map(categories.map((c) => [c.slug, c]));
  return (
    <div className="settings-rail-results">
      {results.slice(0, MAX_RESULTS).map((entry) => {
        const category = byCategory.get(entry.category);
        return (
          <Link
            key={`${entry.category}/${entry.section}/${entry.formName ?? entry.label}`}
            to={`/settings/${entry.category}/${entry.section}`}
            className="settings-rail-result"
          >
            <span className="settings-rail-result-label">{entry.label}</span>
            <span className="settings-rail-result-where">
              {category?.label ?? entry.category} · {entry.section}
            </span>
            {entry.key ? <span className="settings-rail-result-key">{entry.key}</span> : null}
          </Link>
        );
      })}
      {results.length > MAX_RESULTS ? (
        <div className="settings-rail-empty">
          +{results.length - MAX_RESULTS} more — narrow the search.
        </div>
      ) : null}
    </div>
  );
}
