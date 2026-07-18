import { Tooltip } from 'antd';
import { AudioBars } from '../../components/chat/VoiceButton';
import type { VoiceCallStatus } from './voice-call-reducer';

// Talk-mode UI — deliberately minimal per the plan (§4 Phase B): a call toggle
// plus an in-call speaking indicator. No new full-screen surface; the call bar is
// a slim overlay on the existing Chat, honoring DESIGN.md "cards earn existence".
//
// The speaking indicator is the one NEW visual pattern (appended to DESIGN.md):
// the user's live mic reuses `AudioBars` (the composer's red level meter), and a
// distinct accent-colored pulse marks when the agent is speaking.

const STATUS_LABEL: Record<VoiceCallStatus, string> = {
  idle: '',
  connecting: 'Connecting…',
  listening: 'Listening',
  agent_speaking: 'Speaking',
  interrupted: 'Interrupted — go ahead',
  ended: 'Call ended',
};

export interface TalkModeToggleProps {
  /** §3(e) gate — the active personality's toolset enables voice. */
  canTalk: boolean;
  personalityName: string;
  inCall: boolean;
  onToggle: () => void;
}

/** The phone affordance in the personality bar. Disabled + explained when the
 *  personality's toolset does not enable voice (§3(e)). */
export function TalkModeToggle({
  canTalk,
  personalityName,
  inCall,
  onToggle,
}: TalkModeToggleProps) {
  const tip = canTalk
    ? inCall
      ? 'In call'
      : `Talk to ${personalityName}`
    : `Voice not enabled for ${personalityName} — add the voice_session capability to its toolset`;

  return (
    <Tooltip title={tip}>
      <button
        type="button"
        className={`talk-toggle-btn${inCall ? ' talk-toggle-active' : ''}`}
        onClick={onToggle}
        disabled={!canTalk || inCall}
        aria-label={tip}
        aria-pressed={inCall}
      >
        <PhoneIcon />
      </button>
    </Tooltip>
  );
}

export interface TalkModeCallBarProps {
  status: VoiceCallStatus;
  micLevels: number[];
  muted: boolean;
  error: string | null;
  onToggleMute: () => void;
  onHangUp: () => void;
}

/** In-call control strip: speaking indicator, status, mute, hang-up. */
export function TalkModeCallBar({
  status,
  micLevels,
  muted,
  error,
  onToggleMute,
  onHangUp,
}: TalkModeCallBarProps) {
  return (
    <section className="talk-call-bar" aria-label="Voice call controls">
      <SpeakingIndicator status={status} micLevels={micLevels} muted={muted} />
      <span className="talk-status-label">{error ?? STATUS_LABEL[status]}</span>
      <div className="talk-call-actions">
        <button
          type="button"
          className={`talk-btn${muted ? ' talk-btn-active' : ''}`}
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          type="button"
          className="talk-btn talk-hangup-btn"
          onClick={onHangUp}
          aria-label="End call"
        >
          <PhoneDownIcon />
        </button>
      </div>
    </section>
  );
}

function SpeakingIndicator({
  status,
  micLevels,
  muted,
}: {
  status: VoiceCallStatus;
  micLevels: number[];
  muted: boolean;
}) {
  if (status === 'agent_speaking') {
    return (
      <div className="talk-indicator" role="img" aria-label="Agent is speaking">
        <span className="talk-agent-pulse" />
      </div>
    );
  }
  // Listening / interrupted / connecting — show the live mic meter. Muted flat.
  return (
    <div className={`talk-indicator${muted ? ' talk-indicator-muted' : ''}`}>
      <AudioBars levels={micLevels} />
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.5c0 5.25 4.25 9.5 9.5 9.5 .55 0 1-.45 1-1v-1.8a1 1 0 0 0-.76-.97l-2.1-.53a1 1 0 0 0-1 .35l-.5.63A7.5 7.5 0 0 1 5.3 5.86l.63-.5a1 1 0 0 0 .35-1L5.75 2.26A1 1 0 0 0 4.78 1.5H3c-.55 0-1 .45-1 1z" />
    </svg>
  );
}

function PhoneDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 9.5c3.6-3.6 9.4-3.6 13 0l-1.6 1.6a1 1 0 0 1-1.2.16l-1.5-.85a1 1 0 0 1-.5-.87V8.3a7.7 7.7 0 0 0-3.4 0v1.24a1 1 0 0 1-.5.87l-1.5.85a1 1 0 0 1-1.2-.16z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="8"
        y1="13"
        x2="8"
        y2="15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="8"
        y1="13"
        x2="8"
        y2="15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        y1="2"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
