import { useState } from 'react';
import { parseSlugList } from './settings-form';
import type { WorldConfig } from './types';

/** A form for world.yaml. `id` and `backend` are shown but cannot be edited (the save input has no field for them). */
export function SettingsView({
  config,
  saving,
  error,
  onSave,
}: {
  config: WorldConfig;
  saving: boolean;
  error: string | null;
  onSave: (next: {
    title: string;
    audience: WorldConfig['audience'];
    readers: string[];
    proposers: string[];
  }) => void;
}) {
  const [title, setTitle] = useState(config.title);
  const [audience, setAudience] = useState(config.audience);
  const [readers, setReaders] = useState(config.readers.join(', '));
  const [proposers, setProposers] = useState(config.proposers.join(', '));
  const r = parseSlugList(readers);
  const p = parseSlugList(proposers);
  const invalid = [...r.invalid, ...p.invalid];
  const valid = title.trim().length > 0 && invalid.length === 0;

  return (
    <form
      className="world-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ title: title.trim(), audience, readers: r.slugs, proposers: p.slugs });
      }}
    >
      <label className="world-field">
        <span className="world-micro">id</span>
        <input className="world-input" value={config.id} readOnly aria-label="World id" />
      </label>
      <label className="world-field">
        <span className="world-micro">backend</span>
        <input className="world-input" value={config.backend} readOnly aria-label="Backend" />
      </label>
      <label className="world-field">
        <span className="world-micro">title</span>
        <input
          className="world-input"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="world-field">
        <span className="world-micro">audience</span>
        <select
          aria-label="Audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value === 'shareable' ? 'shareable' : 'owner_only')}
        >
          <option value="owner_only">owner only</option>
          <option value="shareable">shareable</option>
        </select>
      </label>
      <label className="world-field">
        <span className="world-micro">readers (personality ids)</span>
        <input
          className="world-input"
          aria-label="Readers"
          value={readers}
          onChange={(e) => setReaders(e.target.value)}
        />
      </label>
      <label className="world-field">
        <span className="world-micro">proposers (personality ids)</span>
        <input
          className="world-input"
          aria-label="Proposers"
          value={proposers}
          onChange={(e) => setProposers(e.target.value)}
        />
      </label>
      {invalid.length > 0 ? (
        <p className="world-errors" role="alert">
          Not a personality id: {invalid.join(', ')}
        </p>
      ) : null}
      {error ? (
        <p className="world-errors" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="world-btn world-btn-primary" disabled={!valid || saving}>
        Save settings
      </button>
    </form>
  );
}
