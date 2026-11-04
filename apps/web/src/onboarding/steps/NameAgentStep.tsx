import { useQuery } from '@tanstack/react-query';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';
import type { WizardAnswers } from '../reducer';

// D15 / Q3 (plan keyless-first-run §4.2): setup ends with a user-owned, born
// copy of the picked built-in. The copy is the default; keeping the built-in is
// the secondary choice and skips naming and connectors (built-ins are
// read-only, so they can run neither the first-chat introduction nor take
// connectors — `requireMutable` in extensions/personalities/src/index.ts).

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

export function NameAgentStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const sourceId = answers.builtInPersonalityId ?? answers.personalityId ?? '';
  const { data } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });
  const builtInName = data?.items.find((p) => p.id === sourceId)?.name ?? sourceId;

  const [name, setName] = useState<string>(answers.agentName ?? '');
  const effectiveName = name.trim() || `My ${builtInName}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!sourceId) return;
    // Coming back to this step with the same name must not duplicate again.
    if (answers.agentName === effectiveName && answers.builtInPersonalityId === sourceId) {
      onNext({ keepBuiltIn: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { personalityId } = await rpc.onboarding.namePersonality({
        sourceId,
        name: effectiveName,
      });
      onNext({
        personalityId,
        builtInPersonalityId: sourceId,
        agentName: effectiveName,
        keepBuiltIn: false,
      });
    } catch (err) {
      const code = errorCode(err);
      if (code === 'PERSONALITY_EXISTS') {
        setError(`An agent named "${effectiveName}" already exists. Pick another name.`);
      } else if (code === 'BAD_REQUEST') {
        setError('That name cannot be used. Use letters and numbers.');
      } else if (code === 'PERSONALITY_NOT_FOUND') {
        setError(`The built-in "${sourceId}" no longer exists. Go back and pick again.`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Name your agent.</h1>
      <p className="onboarding-supporting">
        You get your own copy of {builtInName}. It keeps the same voice and toolset, and in its
        first chat it asks what to call itself.
      </p>

      <div className="onboarding-field">
        <label htmlFor="onboarding-agent-name" className="onboarding-field-label">
          NAME
        </label>
        <Input
          id="onboarding-agent-name"
          value={name}
          maxLength={64}
          placeholder={`My ${builtInName}`}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void create()}
          autoComplete="off"
        />
      </div>

      {error ? (
        <div className="onboarding-error" role="alert">
          ✕ {error}
        </div>
      ) : null}

      <div className="onboarding-actions">
        <Button type="primary" loading={busy} disabled={!sourceId} onClick={() => void create()}>
          Create {effectiveName}
        </Button>
      </div>

      <button
        type="button"
        className="onboarding-expand-btn"
        onClick={() =>
          onNext({ keepBuiltIn: true, personalityId: sourceId, builtInPersonalityId: sourceId })
        }
      >
        Keep the built-in {builtInName}
      </button>
      <div className="onboarding-disabled-reason">
        Built-ins are read-only, so this skips the first-chat introduction and connectors.
      </div>
    </section>
  );
}
