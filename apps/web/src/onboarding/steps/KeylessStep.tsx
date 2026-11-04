import type { KeylessCandidate, KeylessModelId } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Select } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';
import { belowFloorText } from '../local-floor';
import type { WizardAnswers } from '../reducer';

// Keyless first run (plan keyless-first-run §3.5). Shows what the probe found on
// this machine and lets the user pick a model source without pasting a key.
// Web NEVER installs (D11): the install offer is command text plus a Copy
// button and a "Check again" button. The only thing the server runs on our
// behalf is a model pull the user asks for (D12).

/** The base URL an Ollama we found (or that the user installed) is written with (D14). */
export const INSTALLED_BASE_URL = 'http://127.0.0.1:11434/v1';

/** The consent copy of plan §3.2, verbatim. */
export const CODEX_IMPORT_CONSENT =
  'Ethos will copy your Codex sign-in into its own secret store. Both apps will then share one sign-in. When either app refreshes it, the other can be signed out. To keep them separate, choose "Sign in with ChatGPT" instead.';

const NO_MODEL_PATCH: Partial<WizardAnswers> = {
  apiKey: undefined,
  baseUrl: undefined,
  model: undefined,
  models: undefined,
};

/** `paste-key`: clear anything a previous pick left behind, then use the existing flow. */
export const PASTE_KEY_PATCH: Partial<WizardAnswers> = {
  ...NO_MODEL_PATCH,
  provider: undefined,
  keylessPath: 'key',
};

/** Catalog provider id a probed local runtime is written as. vLLM speaks the OpenAI API. */
export function localProviderId(
  provider: 'ollama' | 'vllm' | 'openai-compat',
): 'ollama' | 'openai-compat' {
  return provider === 'ollama' ? 'ollama' : 'openai-compat';
}

export function localPatch(
  candidate: Extract<KeylessCandidate, { kind: 'local' }>,
  model: string,
): Partial<WizardAnswers> {
  return {
    provider: localProviderId(candidate.provider),
    baseUrl: candidate.baseUrl,
    apiKey: 'local',
    model,
    models: candidate.models,
    keylessPath: 'local',
  };
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function KeylessStep({ onNext }: { onNext: (patch: Partial<WizardAnswers>) => void }) {
  const probe = useQuery({
    queryKey: ['onboarding', 'probe'],
    queryFn: () => rpc.onboarding.probe(),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    gcTime: 0,
  });

  const pasteKey = () => onNext(PASTE_KEY_PATCH);

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Find a model to answer with.</h1>
      <p className="onboarding-supporting">
        Ethos looks on this machine for a model it can use without an API key.
      </p>

      {probe.isFetching ? (
        <div className="onboarding-supporting" role="status">
          Looking for a model on this machine…
        </div>
      ) : null}

      {probe.isError ? (
        <div className="onboarding-warning" role="alert">
          Could not check this machine: {errorMessage(probe.error)}. Paste an API key instead.
        </div>
      ) : null}

      {probe.data ? (
        <div className="onboarding-found-list">
          {probe.data.candidates.map((c, i) =>
            c.kind === 'paste-key' ? null : (
              <CandidateRow
                // biome-ignore lint/suspicious/noArrayIndexKey: candidates are a fixed ordered list
                key={`${c.kind}-${i}`}
                candidate={c}
                recommended={i === probe.data.recommended}
                probe={probe.data}
                onNext={onNext}
                onRecheck={() => void probe.refetch()}
              />
            ),
          )}
        </div>
      ) : null}

      <div className="onboarding-actions">
        <Button onClick={pasteKey}>Paste an API key</Button>
      </div>
    </section>
  );
}

type ProbeData = Awaited<ReturnType<typeof rpc.onboarding.probe>>;

function CandidateRow({
  candidate,
  recommended,
  probe,
  onNext,
  onRecheck,
}: {
  candidate: KeylessCandidate;
  recommended: boolean;
  probe: ProbeData;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onRecheck: () => void;
}) {
  switch (candidate.kind) {
    case 'local':
      return (
        <LocalRow
          candidate={candidate}
          recommended={recommended}
          onNext={onNext}
          onRecheck={onRecheck}
        />
      );
    case 'ethos-login':
      return <EthosLoginRow recommended={recommended} onNext={onNext} />;
    case 'external-login':
      return <ExternalLoginRow candidate={candidate} recommended={recommended} onNext={onNext} />;
    case 'install-offer':
      return <InstallRow probe={probe} onNext={onNext} onRecheck={onRecheck} />;
    case 'paste-key':
      return null;
  }
}

function RowHead({ title, recommended }: { title: string; recommended: boolean }) {
  return (
    <div className="onboarding-provider-name-row">
      <span className="onboarding-provider-label">{title}</span>
      {recommended ? <span className="onboarding-recommended-tag">recommended</span> : null}
    </div>
  );
}

function LocalRow({
  candidate,
  recommended,
  onNext,
  onRecheck,
}: {
  candidate: Extract<KeylessCandidate, { kind: 'local' }>;
  recommended: boolean;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onRecheck: () => void;
}) {
  const [model, setModel] = useState(candidate.models[0] ?? '');
  const floorText = belowFloorText(candidate);
  return (
    <div className="onboarding-found">
      <RowHead
        title={`${candidate.runtime} is running on this machine`}
        recommended={recommended}
      />
      <div className="onboarding-provider-hint">
        <code>{candidate.baseUrl}</code> · {candidate.models.length}{' '}
        {candidate.models.length === 1 ? 'model' : 'models'}
        {candidate.contextWindow
          ? ` · ${candidate.contextWindow.toLocaleString()} token window`
          : ''}
      </div>
      {floorText ? <div className="onboarding-warning">{floorText}</div> : null}
      <div className="onboarding-found-actions">
        {candidate.models.length > 1 ? (
          <Select
            size="small"
            value={model}
            onChange={setModel}
            options={candidate.models.map((m) => ({ value: m, label: m }))}
            style={{ minWidth: 180 }}
            aria-label="Model"
          />
        ) : null}
        <Button
          type="primary"
          disabled={!model || floorText !== null}
          onClick={() => onNext(localPatch(candidate, model))}
        >
          Use {model || 'this model'}
        </Button>
        {floorText ? <Button onClick={onRecheck}>Check again</Button> : null}
      </div>
    </div>
  );
}

function EthosLoginRow({
  recommended,
  onNext,
}: {
  recommended: boolean;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.onboarding.validateProvider({ provider: 'codex', apiKey: 'no-key' });
      if (!result.ok) {
        setError(result.error ?? 'The saved ChatGPT sign-in no longer works. Sign in again.');
        return;
      }
      onNext({
        ...NO_MODEL_PATCH,
        provider: 'codex',
        apiKey: '',
        models: result.models ?? [],
        keylessPath: 'ethos-login',
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-found">
      <RowHead title="You are already signed in with ChatGPT" recommended={recommended} />
      <div className="onboarding-provider-hint">Ethos already holds a Codex sign-in.</div>
      {error ? (
        <div className="onboarding-error" role="alert">
          ✕ {error}
        </div>
      ) : null}
      <div className="onboarding-found-actions">
        <Button type="primary" loading={busy} onClick={() => void use()}>
          Use my ChatGPT sign-in
        </Button>
      </div>
    </div>
  );
}

function ExternalLoginRow({
  candidate,
  recommended,
  onNext,
}: {
  candidate: Extract<KeylessCandidate, { kind: 'external-login' }>;
  recommended: boolean;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appName = candidate.source === 'hermes' ? 'Hermes' : 'Codex';

  const importLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.onboarding.importCodexLogin({ source: candidate.source });
      if (!result.ok) {
        setError(
          result.code === 'absent'
            ? `The ${appName} sign-in is no longer there. Sign in with ChatGPT instead.`
            : `The ${appName} sign-in file is in a format Ethos does not recognise. Sign in with ChatGPT instead.`,
        );
        return;
      }
      onNext({
        ...NO_MODEL_PATCH,
        provider: 'codex',
        apiKey: '',
        models: result.models,
        keylessPath: 'external-login',
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Q2: the device flow (Ethos's own grant) is the default; the import is the
  // secondary button. It lives in the auth step, so leave models unset and the
  // reducer routes there.
  const signIn = () => onNext({ ...NO_MODEL_PATCH, provider: 'codex', keylessPath: 'ethos-login' });

  return (
    <div className="onboarding-found">
      <RowHead title={`A ${appName} sign-in was found`} recommended={recommended} />
      <div className="onboarding-provider-hint">{CODEX_IMPORT_CONSENT}</div>
      {error ? (
        <div className="onboarding-error" role="alert">
          ✕ {error}
        </div>
      ) : null}
      <div className="onboarding-found-actions">
        <Button type="primary" onClick={signIn}>
          Sign in with ChatGPT
        </Button>
        <Button loading={busy} onClick={() => void importLogin()}>
          Import my {appName} sign-in
        </Button>
      </div>
    </div>
  );
}

function InstallRow({
  probe,
  onNext,
  onRecheck,
}: {
  probe: ProbeData;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onRecheck: () => void;
}) {
  const { install, machine } = probe;
  const [copied, setCopied] = useState(false);
  const pull = usePull();
  const modelId = machine.pick.modelId;

  const copy = async () => {
    if (!install.command) return;
    try {
      await navigator.clipboard.writeText(install.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="onboarding-found">
      <RowHead title="Install Ollama and run a local model" recommended={false} />
      <div className="onboarding-provider-hint">
        {install.notes} Ethos does not run the install for you.
      </div>
      {install.command ? <pre className="onboarding-code">{install.command}</pre> : null}
      <div className="onboarding-found-actions">
        {install.command ? (
          <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
        ) : null}
        {install.downloadUrl ? (
          <a
            href={install.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="onboarding-signup-link"
          >
            Download Ollama →
          </a>
        ) : null}
        <Button onClick={onRecheck}>Check again</Button>
      </div>

      <div className="onboarding-provider-hint">
        Once Ollama is running, download a model sized for this machine ({machine.totalMemGiB} GiB
        of memory).
      </div>
      {pull.error ? (
        <div className="onboarding-error" role="alert">
          ✕ {pull.error}
        </div>
      ) : null}
      {pull.state === 'pulling' ? (
        <div className="onboarding-pull-progress" role="status">
          {pull.percent}% · {formatGb(pull.completedBytes)} of {formatGb(pull.totalBytes)} GB
        </div>
      ) : null}
      <div className="onboarding-found-actions">
        {pull.state === 'done' ? (
          <Button
            type="primary"
            onClick={() =>
              onNext({
                provider: 'ollama',
                baseUrl: INSTALLED_BASE_URL,
                apiKey: 'local',
                model: modelId,
                models: [modelId],
                keylessPath: 'installed',
              })
            }
          >
            Use {modelId}
          </Button>
        ) : (
          <Button
            type="primary"
            loading={pull.state === 'pulling'}
            onClick={() => void pull.start(modelId)}
          >
            Download {modelId} (about {machine.pick.approxDownloadGb} GB)
          </Button>
        )}
      </div>
    </div>
  );
}

function formatGb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

const PULL_POLL_MS = 1500;

type PullState = 'idle' | 'pulling' | 'done' | 'error';

/** Start a model pull and poll `pullStatus` until it settles. */
function usePull() {
  const [state, setState] = useState<PullState>('idle');
  const [completedBytes, setCompleted] = useState(0);
  const [totalBytes, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const poll = () => {
    stop();
    timer.current = setInterval(async () => {
      try {
        const s = await rpc.onboarding.pullStatus();
        setCompleted(s.completedBytes);
        setTotal(s.totalBytes);
        if (s.state === 'done') {
          stop();
          setState('done');
        } else if (s.state === 'error') {
          stop();
          setState('error');
          setError(s.error ?? 'The download failed.');
        }
      } catch {
        // transient — keep polling
      }
    }, PULL_POLL_MS);
  };

  const start = async (model: KeylessModelId) => {
    setError(null);
    setState('pulling');
    try {
      await rpc.onboarding.pullModel({ model });
      poll();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'PULL_IN_PROGRESS') {
        poll();
        return;
      }
      setState('error');
      setError(
        code === 'LOCAL_RUNTIME_UNREACHABLE'
          ? 'Ollama is not running at 127.0.0.1:11434. Install and start it, then try again.'
          : errorMessage(err),
      );
    }
  };

  const percent =
    totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 0;
  return { state, completedBytes, totalBytes, percent, error, start };
}
