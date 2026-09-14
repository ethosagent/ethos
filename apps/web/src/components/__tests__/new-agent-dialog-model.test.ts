// The rail-`+` Quick create dialog chooses a personality's model with the same
// closed control as the create wizard (plan model-registry D5): a role or a
// registry alias, never a typed vendor id. Source-level, like
// `pages/__tests__/personality-model-choices.test.ts` — the control itself is
// rendered and covered there.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dialog = readFileSync(join(import.meta.dirname, '..', 'NewAgentDialog.tsx'), 'utf8');

describe('NewAgentDialog model field', () => {
  it('the new-agent dialog has no free-text model control', () => {
    expect(dialog).not.toContain('AutoComplete');
    expect(dialog).not.toContain('modelOptionsForProvider');
    expect(dialog).not.toContain('rpc.models.catalog');
    const field = dialog.slice(dialog.indexOf('label="Model"'));
    expect(field.slice(0, field.indexOf('</Form.Item>'))).toContain('<ModelDeclarationSelect');
    expect(dialog.match(/<ModelDeclarationSelect\b/g)?.length).toBe(1);
  });

  it('sends model on create only when a declaration is chosen ("Use default" is omitted)', () => {
    expect(dialog).toContain('...(state.model ? { model: state.model } : {})');
  });

  it('has no personality provider field', () => {
    expect(dialog).not.toContain('label="Provider"');
    expect(dialog).not.toMatch(/provider:/);
  });
});
