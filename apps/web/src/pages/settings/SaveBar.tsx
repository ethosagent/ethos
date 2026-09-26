// The page Save, sticky at the bottom of the detail column.
//
// It calls `form.submit()` rather than carrying `htmlType="submit"`, because the
// shell's `<Form>` renders `component={false}` and there is no `<form>` node to
// submit (D2).
//
// The count beside it is cross-category by construction (D9): the save writes
// every category at once, so a bar that only counted the pane on screen would
// under-report exactly what it is about to do. `3 changes · Voice, Memory`.
//
// `warnings` (B2, web save half) are the config parser's lines for the file as
// it stands — `config.yaml:<n> unknown key '<k>' — did you mean …?`. They
// render as `N unknown keys kept · view`, and "view" reveals the lines as ROWS
// in place (DESIGN.md §Feedback & activity item 6 — never a toast). The save
// keeps those keys on purpose (passthrough); the bar's job is only to stop
// them being kept silently.

import { Button } from 'antd';
import { useState } from 'react';
import type { DirtyState } from './lib/settings-dirty';
import type { SettingsCategory } from './lib/taxonomy';

export function SaveBar({
  loading,
  onSave,
  dirty,
  categories,
  warnings = [],
}: {
  loading: boolean;
  onSave: () => void;
  dirty: DirtyState;
  categories: SettingsCategory[];
  /** Parser warnings for the saved file (`config.update` / `config.get`). */
  warnings?: readonly string[];
}) {
  const [warningsOpen, setWarningsOpen] = useState(false);
  const labels = dirty.categories.map(
    (slug) => categories.find((c) => c.slug === slug)?.label ?? slug,
  );
  const unknownCount = warnings.filter((w) => w.includes('unknown key')).length;
  const warningsLabel =
    unknownCount > 0
      ? `${unknownCount} unknown ${unknownCount === 1 ? 'key' : 'keys'} kept`
      : `${warnings.length} config ${warnings.length === 1 ? 'warning' : 'warnings'}`;
  return (
    <div className="settings-savebar">
      <Button type="primary" loading={loading} onClick={onSave}>
        Save
      </Button>
      {dirty.count > 0 ? (
        <span className="settings-savebar-dirty">
          <span className="settings-savebar-count">{dirty.count}</span>
          {dirty.count === 1 ? ' change' : ' changes'}
          {labels.length > 0 ? ` · ${labels.join(', ')}` : ''}
        </span>
      ) : null}
      {warnings.length > 0 ? (
        <button
          type="button"
          className="settings-savebar-warnings-toggle"
          aria-expanded={warningsOpen}
          onClick={() => setWarningsOpen((v) => !v)}
        >
          ⚠ {warningsLabel} · {warningsOpen ? 'hide' : 'view'}
        </button>
      ) : null}
      {warningsOpen && warnings.length > 0 ? (
        <ul className="settings-savebar-warnings">
          {warnings.map((w) => (
            <li key={w} className="settings-savebar-warning-row">
              {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
