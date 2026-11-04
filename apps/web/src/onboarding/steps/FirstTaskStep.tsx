import { Button } from 'antd';
import { firstTaskSuggestions } from '../first-task';

// D16/D17 (plan keyless-first-run §4.2): up to four suggestions. Choosing one
// prefills the chat composer; the user still presses Send. Never injected into
// a prompt. Skip opens an empty chat.
export function FirstTaskStep({
  connected,
  onPick,
  onSkip,
}: {
  connected: readonly string[];
  onPick: (text: string) => void;
  onSkip: () => void;
}) {
  const suggestions = firstTaskSuggestions(connected);
  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Try a first task.</h1>
      <p className="onboarding-supporting">
        Picking one fills the message box. Nothing is sent until you press Send.
      </p>
      <div className="onboarding-providers">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            className="onboarding-provider onboarding-first-task"
            onClick={() => onPick(text)}
          >
            <span className="onboarding-provider-label">{text}</span>
          </button>
        ))}
      </div>
      <div className="onboarding-actions">
        <Button onClick={onSkip}>Skip</Button>
      </div>
    </section>
  );
}
