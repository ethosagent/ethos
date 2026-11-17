// @vitest-environment jsdom
//
// Pins the export surface of `pages/Personalities.tsx`. The page was split into
// `pages/personalities/*`; importers (App.tsx, PersonalityDetail.tsx,
// NewAgentDialog.tsx, three tests) keep importing from the original module, so
// every symbol it exported must still be exported from it.

import { describe, expect, it, vi } from 'vitest';
import type {
  EditModalTabKey as EditModalTabKeyViaPage,
  ServerToolState as ServerToolStateViaPage,
} from '../Personalities';

vi.mock('../../rpc', () => ({ rpc: {} }));

// Type-only exports: a missing one fails `pnpm --filter @ethosagent/web typecheck`.
export type TypeSurface = [EditModalTabKeyViaPage, ServerToolStateViaPage];

describe('Personalities export surface', () => {
  it('exports the same runtime symbols as before the split', async () => {
    const mod = await import('../Personalities');
    expect(Object.keys(mod).sort()).toEqual([
      'ConfigEditor',
      'DuplicateModal',
      'EditModal',
      'IdentityEditor',
      'Personalities',
      'ServerToolChecklist',
      'SkillsPicker',
      'ToolsetPicker',
      'WizardPluginsTab',
      'initialSelectionFor',
      'slugify',
    ]);
  });
});
