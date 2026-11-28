import { useState } from 'react';

/** Read-only YAML and version history. No input of any kind: edits happen in chat. */
export function ShowFile({
  yaml,
  versions,
}: {
  yaml: string;
  versions: Array<{ version: number; savedAt?: string | undefined }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="page-action-btn"
        data-testid="initiative-show-file"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide file' : 'Show file'}
      </button>
      {open ? (
        <div data-testid="initiative-file" className="initiative-file">
          <pre data-testid="initiative-yaml" className="initiative-yaml">
            {yaml}
          </pre>
          <div className="initiative-section-label">Version history</div>
          <ol className="initiative-versions">
            {versions.map((v) => (
              <li key={v.version} data-version={v.version}>
                v{v.version}
                {v.savedAt ? ` · ${new Date(v.savedAt).toLocaleString()}` : ''}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
