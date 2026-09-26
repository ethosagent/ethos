import { describe, expect, it } from 'vitest';
import { candidateView } from '../skills';

describe('candidateView', () => {
  it('reads name and description from the front matter', () => {
    const v = candidateView(
      'deploy-check.md',
      '---\nname: Deploy check\ndescription: "Verify a deploy"\n---\n# Steps\n1. look\n',
    );
    expect(v).toEqual({
      name: 'Deploy check',
      description: 'Verify a deploy',
      body: '# Steps\n1. look',
    });
  });

  it('falls back to the file name with no front matter', () => {
    expect(candidateView('triage.md', 'Just text.')).toEqual({
      name: 'triage',
      description: null,
      body: 'Just text.',
    });
  });
});
