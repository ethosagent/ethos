import { expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { Mark } from '../Mark';
import { Row } from '../Row';

// Case 16 (the Row and Mark half): glyph-word, subject, result, time — in that
// order — and a mark that names its personality. Tab badges are native
// (UITabBarController) and are read by VoiceOver itself; that half is on the
// manual checklist.
it('reads a row as word, subject, result, time', async () => {
  await render(
    <Row row={{ glyph: '✓', word: 'allowed', subject: 'bash', result: 'once', time: '09:41' }} />,
  );
  expect(screen.getByLabelText('allowed, bash, once, 09:41')).toBeTruthy();
});

it('names the personality behind a mark', async () => {
  await render(<Mark personalityId="engineer" />);
  expect(screen.getByLabelText('engineer personality')).toBeTruthy();
});
