import { APPROVAL_NOTE_MAX_CHARS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { formatApprovalDenial, sanitizeApprovalNote } from '../approval-note';

describe('approval note', () => {
  it('sanitizeApprovalNote returns undefined for blank or invisible-only input', () => {
    expect(sanitizeApprovalNote(undefined)).toBeUndefined();
    expect(sanitizeApprovalNote('   \n\t ')).toBeUndefined();
    expect(sanitizeApprovalNote('​‮﻿')).toBeUndefined();
  });
  it('strips C0/C1 controls and hidden code points but keeps newlines', () => {
    expect(sanitizeApprovalNote('use \u001b[2Jstaging‮\r\nDB\u0085')).toBe('use [2Jstaging\nDB');
  });
  it('turns tabs into spaces', () => {
    expect(sanitizeApprovalNote('a\tb')).toBe('a b');
  });
  it('caps at APPROVAL_NOTE_MAX_CHARS code points with an ellipsis, never splitting a surrogate pair', () => {
    const out = sanitizeApprovalNote('😀'.repeat(APPROVAL_NOTE_MAX_CHARS + 5)) ?? '';
    expect(Array.from(out)).toHaveLength(APPROVAL_NOTE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
  it('formatApprovalDenial keeps the legacy string when there is no note', () => {
    expect(
      formatApprovalDenial({ reason: 'denied by user', dangerReason: 'recursive delete' }),
    ).toBe('denied by user — recursive delete');
  });
  it('formatApprovalDenial appends the user instruction', () => {
    expect(
      formatApprovalDenial({
        reason: 'denied by user',
        dangerReason: 'recursive delete',
        note: 'use staging',
      }),
    ).toBe(
      'denied by user — recursive delete\nThe user did not allow this call and said what to do instead: use staging',
    );
  });
});
