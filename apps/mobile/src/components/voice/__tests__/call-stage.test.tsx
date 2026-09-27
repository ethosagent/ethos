import { initialVoiceCallState, type VoiceCallState } from '@ethosagent/voice-client';
import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { beforeEach, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Composer } from '../../ui/ChatParts';
import { CallStage } from '../CallStage';

// The Call Stage against a mocked call-store: the controls reach the store's
// actions, End hangs up and leaves, Back to chat leaves and keeps the call,
// the clarify slot is always there, and every control is labelled.

const mockActions = {
  start: jest.fn(),
  end: jest.fn(),
  toggleMute: jest.fn(),
  holdToTalk: jest.fn(),
  releaseToTalk: jest.fn(),
  dismissNotice: jest.fn(),
};
let mockState: Record<string, unknown> = {};

jest.mock('../../../state/call-store', () => {
  const getState = () => mockState;
  return {
    callStore: { getState },
    useCallStore: (selector: (s: Record<string, unknown>) => unknown) => selector(getState()),
  };
});
// The shape's frame loop is covered by the pure geometry tests.
jest.mock('../CallShape', () => ({ CallShape: () => null }));
// ChatParts' run card reaches the Keychain through the RPC hooks.
jest.mock('../../chat/RunCard', () => ({ RunAnchor: () => null }));

function setCall(call: Partial<VoiceCallState>, extra: Record<string, unknown> = {}) {
  mockState = {
    ...mockActions,
    call: { ...initialVoiceCallState, status: 'listening', ...call },
    muted: false,
    pushToTalk: false,
    held: false,
    realtime: null,
    latency: { llmMs: null, ttsMs: null, totalMs: 640 },
    providerLabel: () => 'openai · gpt-realtime',
    micLevel: () => 0,
    agentLevel: () => 0,
    traceJsonl: () => null,
    ...extra,
  };
}

const clarify = {
  type: 'clarify_request',
  requestId: 'c1',
  question: 'Which branch?',
  options: ['main', 'dev'],
} as unknown as ClarifyRequestEvent;

function stage(overrides: Partial<Parameters<typeof CallStage>[0]> = {}) {
  const props = {
    personalityId: 'engineer',
    name: 'Engineer',
    treatment: 'liquid' as const,
    accent: '#4ADE80',
    clarify: null,
    onAnswerClarify: jest.fn(async () => {}),
    onLeave: jest.fn(),
    topInset: 0,
    bottomInset: 0,
    ...overrides,
  };
  return { props, view: render(<CallStage {...props} />) };
}

beforeEach(() => {
  for (const fn of Object.values(mockActions)) fn.mockClear();
  setCall({});
});

it('labels every control for VoiceOver', async () => {
  const { view } = stage();
  await view;
  for (const name of [
    'Mute microphone',
    'Push to talk',
    'Back to chat — the call keeps running',
    'End call',
  ]) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }
  expect(screen.getByText('openai · gpt-realtime · 640ms')).toBeTruthy();
});

it('End hangs up and leaves; Back to chat leaves and keeps the call', async () => {
  const { props, view } = stage();
  await view;
  await fireEvent.press(
    screen.getByRole('button', { name: 'Back to chat — the call keeps running' }),
  );
  expect(props.onLeave).toHaveBeenCalledTimes(1);
  expect(mockActions.end).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: 'End call' }));
  expect(mockActions.end).toHaveBeenCalledTimes(1);
  expect(props.onLeave).toHaveBeenCalledTimes(2);
});

it('mute toggles and push to talk holds and releases', async () => {
  const { view } = stage();
  await view;
  await fireEvent.press(screen.getByRole('button', { name: 'Mute microphone' }));
  expect(mockActions.toggleMute).toHaveBeenCalledTimes(1);
  const ptt = screen.getByRole('button', { name: 'Push to talk' });
  await fireEvent(ptt, 'pressIn');
  expect(mockActions.holdToTalk).toHaveBeenCalledTimes(1);
  await fireEvent(ptt, 'pressOut');
  expect(mockActions.releaseToTalk).toHaveBeenCalledTimes(1);
});

it('keeps the clarify slot dimmed when empty and fills it when a question is pending', async () => {
  const { view } = stage();
  await view;
  expect(screen.getByLabelText('No open question')).toBeTruthy();
  expect(screen.getByText('No open question')).toBeTruthy();
  await view.then((v) => v.unmount());

  await render(
    <CallStage
      personalityId="engineer"
      name="Engineer"
      treatment="orb"
      accent="#4ADE80"
      clarify={clarify}
      onAnswerClarify={async () => {}}
      onLeave={() => {}}
      topInset={0}
      bottomInset={0}
    />,
  );
  expect(screen.getByLabelText('Question from the agent')).toBeTruthy();
  expect(screen.getByText('Which branch?')).toBeTruthy();
});

it('collapses the slot to a resolved row once answered', async () => {
  const onAnswerClarify = jest.fn(async (_id: string, _a: string) => {});
  const { view } = stage({ clarify, onAnswerClarify });
  await view;
  await fireEvent.press(screen.getByRole('radio', { name: /main/ }));
  await fireEvent.press(screen.getByRole('button', { name: 'Answer' }));
  expect(onAnswerClarify).toHaveBeenCalledWith('c1', 'main');
  expect(await screen.findByLabelText(/^answered, clarify, main/)).toBeTruthy();
  expect(screen.queryByText('Which branch?')).toBeNull();
});

it('says the call is held by a phone call', async () => {
  setCall({}, { held: true });
  const { view } = stage();
  await view;
  expect(screen.getByText('held · phone call')).toBeTruthy();
});

it('names the Settings path when the mic is refused', async () => {
  setCall({ status: 'ended', micDenied: true, error: 'denied' });
  const { view } = stage();
  await view;
  expect(screen.getByText(/Settings → Ethos → Microphone/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Dismiss notice' }));
  expect(mockActions.dismissNotice).toHaveBeenCalledTimes(1);
});

it('renders the composer mic only when the caller offers a call', async () => {
  const onCall = jest.fn();
  const view = await render(
    <Composer
      name="Engineer"
      accent="#4ADE80"
      streaming={false}
      onSend={() => {}}
      onStop={() => {}}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Call Engineer' })).toBeNull();
  await view.unmount();
  await render(
    <Composer
      name="Engineer"
      accent="#4ADE80"
      streaming={false}
      onSend={() => {}}
      onStop={() => {}}
      onCall={onCall}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Call Engineer' }));
  expect(onCall).toHaveBeenCalledTimes(1);
});
