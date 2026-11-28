import { useState } from 'react';
import {
  ATTR_TYPES,
  addEntityType,
  parseNameList,
  removeEdgeType,
  removeEntityAttr,
  removeEntityType,
  setEdgeType,
  setEntityAttr,
} from './schema-form';
import type { SchemaState, WorldSchemaParsed } from './types';

/**
 * Types and allowed links as a form. The draft is the parsed schema; Save
 * serialises it (schema-form.ts `schemaToYaml`) and the server validates. Line
 * errors from a bad hand edit (`loadErrors`) and from a refused save (`saveError`)
 * are listed above the form. This is the control for schema.yaml, not a YAML box.
 */
export function SchemaEditor({
  state,
  saving,
  saveError,
  canUndo,
  onSave,
  onUndo,
}: {
  state: SchemaState;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  onSave: (draft: WorldSchemaParsed, before: WorldSchemaParsed) => void;
  onUndo: () => void;
}) {
  const base = state.parsed;
  const [draft, setDraft] = useState<WorldSchemaParsed | null>(base);
  const [newType, setNewType] = useState('');
  const [newEdge, setNewEdge] = useState({ type: '', from: '', to: '' });
  const [newAttr, setNewAttr] = useState<Record<string, string>>({});

  const issues = (
    <>
      {state.loadErrors.length > 0 ? (
        <ul className="world-errors" role="alert">
          {state.loadErrors.map((e) => (
            <li key={`${e.line}:${e.column ?? 0}:${e.message}`}>
              line {e.line}
              {e.column ? `:${e.column}` : ''}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      {saveError ? (
        <p className="world-errors" role="alert">
          {saveError}
        </p>
      ) : null}
    </>
  );

  if (!base || !draft) {
    return (
      <div>
        {issues}
        <p className="world-empty">
          The stored schema.yaml does not parse, so there is nothing to edit here. Fix the lines
          above in the file.
        </p>
      </div>
    );
  }

  const typeNames = Object.keys(draft.entities);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  return (
    <div>
      {issues}
      <p className="world-small">Schema version {state.version}.</p>

      <h3 className="world-micro">Entity types</h3>
      <ul className="world-rows">
        {typeNames.map((t) => (
          <li key={t} className="world-schema-type">
            <div className="world-line">
              <strong>{t}</strong>
              <button
                type="button"
                className="world-btn"
                onClick={() => setDraft(removeEntityType(draft, t))}
              >
                Remove {t}
              </button>
            </div>
            {Object.entries(draft.entities[t]?.attrs ?? {}).map(([a, spec]) => (
              <div key={a} className="world-line">
                <span className="world-mono">{a}</span>
                <select
                  aria-label={`${t}.${a} type`}
                  value={spec.type}
                  onChange={(e) => {
                    const next = ATTR_TYPES.find((x) => x === e.target.value);
                    if (next) setDraft(setEntityAttr(draft, t, a, next));
                  }}
                >
                  {ATTR_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="world-link"
                  onClick={() => setDraft(removeEntityAttr(draft, t, a))}
                >
                  Remove attribute
                </button>
              </div>
            ))}
            <div className="world-line">
              <input
                className="world-input"
                aria-label={`New attribute on ${t}`}
                placeholder="attribute name"
                value={newAttr[t] ?? ''}
                onChange={(e) => setNewAttr({ ...newAttr, [t]: e.target.value })}
              />
              <button
                type="button"
                className="world-btn"
                onClick={() => {
                  setDraft(setEntityAttr(draft, t, newAttr[t] ?? '', 'string'));
                  setNewAttr({ ...newAttr, [t]: '' });
                }}
              >
                Add attribute
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="world-line">
        <input
          className="world-input"
          aria-label="New entity type"
          placeholder="Type name"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        />
        <button
          type="button"
          className="world-btn"
          onClick={() => {
            setDraft(addEntityType(draft, newType));
            setNewType('');
          }}
        >
          Add type
        </button>
      </div>

      <h3 className="world-micro">Allowed links</h3>
      <ul className="world-rows">
        {Object.entries(draft.edges).map(([t, e]) => (
          <li key={t} className="world-line">
            <span className="world-mono">{t}</span>
            <span>
              {e.from.join(', ')} to {e.to.join(', ')}
            </span>
            <button
              type="button"
              className="world-link"
              onClick={() => setDraft(removeEdgeType(draft, t))}
            >
              Remove link {t}
            </button>
          </li>
        ))}
      </ul>
      <div className="world-line">
        <input
          className="world-input"
          aria-label="New link type"
          placeholder="link name"
          value={newEdge.type}
          onChange={(e) => setNewEdge({ ...newEdge, type: e.target.value })}
        />
        <input
          className="world-input"
          aria-label="Link from types"
          placeholder="from: Person"
          value={newEdge.from}
          onChange={(e) => setNewEdge({ ...newEdge, from: e.target.value })}
        />
        <input
          className="world-input"
          aria-label="Link to types"
          placeholder="to: Team"
          value={newEdge.to}
          onChange={(e) => setNewEdge({ ...newEdge, to: e.target.value })}
        />
        <button
          type="button"
          className="world-btn"
          onClick={() => {
            setDraft(
              setEdgeType(
                draft,
                newEdge.type,
                parseNameList(newEdge.from),
                parseNameList(newEdge.to),
              ),
            );
            setNewEdge({ type: '', from: '', to: '' });
          }}
        >
          Add link
        </button>
      </div>

      <div className="world-toolbar">
        <button
          type="button"
          className="world-btn world-btn-primary"
          disabled={!dirty || saving}
          onClick={() => onSave(draft, base)}
        >
          Save schema
        </button>
        <button type="button" className="world-btn" disabled={!canUndo || saving} onClick={onUndo}>
          Undo last change
        </button>
        <button
          type="button"
          className="world-btn"
          disabled={!dirty}
          onClick={() => setDraft(base)}
        >
          Discard edits
        </button>
      </div>

      <h3 className="world-micro">Changelog</h3>
      {state.changelog.length === 0 ? (
        <p className="world-empty">No changes recorded.</p>
      ) : (
        <ul className="world-rows">
          {[...state.changelog].reverse().map((c) => (
            <li key={`${c.v}:${c.at}`} className="world-line">
              <span className="world-mono world-dim">v{c.v}</span>
              <span>{c.change}</span>
              <span className="world-small world-dim">
                {c.by} · {c.at.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
