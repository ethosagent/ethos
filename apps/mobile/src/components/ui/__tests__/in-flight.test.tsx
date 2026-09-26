import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApprovalPanel, type Decision } from '../ApprovalPanel';

jest.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Warning: 'warning' },
  notificationAsync: jest.fn(async () => undefined),
}));

const request: ApprovalRequest = {
  approvalId: 'a1',
  sessionId: 's1',
  toolCallId: 'tc1',
  toolName: 'bash',
  args: { command: 'git push origin main' },
  reason: 'pushes to a shared branch',
  alwaysAsk: false,
  hardline: false,
};

// Case 18: tap Allow, then tap again while the decision is in flight.
it('disables both buttons with labels unchanged and decides exactly once', async () => {
  const onDecide = jest.fn((_d: Decision) => new Promise<unknown>(() => {}));
  const onDeciding = jest.fn();
  const view = await render(
    <ApprovalPanel
      request={request}
      agent="Engineer"
      accent="#4ADE80"
      queued={1}
      onDecide={onDecide}
      onDeciding={onDeciding}
    />,
  );
  await fireEvent.press(screen.getByText('Allow'));
  await fireEvent.press(screen.getByText('Allow'));
  await fireEvent.press(screen.getByText('Deny'));

  expect(onDecide).toHaveBeenCalledTimes(1);
  expect(onDecide).toHaveBeenCalledWith({ allow: true, scope: 'once' });
  expect(onDeciding).toHaveBeenLastCalledWith(true);
  for (const label of ['Allow', 'Deny']) {
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
  }

  // `approval.resolved` → the parent stops rendering the panel; the slot clears.
  await view.unmount();
  expect(onDeciding).toHaveBeenLastCalledWith(false);
});
