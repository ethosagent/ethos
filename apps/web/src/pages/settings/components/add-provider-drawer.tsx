// The Add provider drawer (approved "Providers & models" mockup, frame 3): two
// steps in one drawer.
//
//   1 Connect — Type is a closed Select over `SETTINGS_PROVIDER_TYPES` (the web
//     onboarding catalog plus the Settings-only azure and bedrock); Id is
//     prefilled with a free slug and editable; only the fields the type's
//     `authType` needs. Test connection runs `onboarding.validateProvider`
//     where the type supports it, and "Continue without testing" is explicit.
//     Codex signs in with the same device flow onboarding uses
//     (`/auth/codex/*`, apps/web-api routes/codex-auth.ts).
//   2 Choose models — a checklist of the catalog's models for that type, an
//     "Another model id" input that takes several ids, and an editable alias
//     preview per chosen id.
//
// "Add provider and N models" is ONE `modelRegistry.addProvider` call. A
// refusal is a value, rendered inline, and the drawer stays open.

import type {
  ModelRegistryAddProviderResult,
  ModelRegistryProviderRefusal,
} from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Drawer, Input, Select } from 'antd';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { rpc } from '../../../rpc';
import { formatContextWindow, modelCatalogKey } from '../lib/model-registry';
import {
  addProviderRequest,
  type CatalogPick,
  type ConnectDraft,
  catalogPicks,
  connectBlocker,
  connectFields,
  parseModelIds,
  previewAliases,
  providerExtraFields,
  SETTINGS_PROVIDER_TYPES,
  type SettingsProviderType,
  settingsProviderType,
  uniqueProviderId,
} from '../lib/providers-and-models';
import { MONO, messageOf, RefusalNotice } from './model-registry-notices';

const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const LABEL: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' };
const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };
const OPTION: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'baseline',
};
const CHECK_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'baseline',
  padding: '6px 0',
  borderBottom: '1px solid var(--border-subtle)',
  fontSize: 13,
};
const ALIAS_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 8,
  alignItems: 'center',
};

type ConnectTest =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; models: number | null }
  | { state: 'error'; error: string }
  | { state: 'signed-in' };

export function AddProviderDrawer({
  takenKeys,
  existingAliases,
  onClose,
  onAdded,
}: {
  /** Every provider key already in the chain. */
  takenKeys: readonly string[];
  /** Every alias already in the registry. */
  existingAliases: readonly string[];
  onClose: () => void;
  onAdded: (result: Extract<ModelRegistryAddProviderResult, { ok: true }>) => void;
}) {
  const ids = useId();
  const catalogQuery = useQuery({
    queryKey: modelCatalogKey(),
    queryFn: () => rpc.models.catalog(),
  });
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<ConnectDraft>(() => initialDraft('anthropic', takenKeys));
  const [idEdited, setIdEdited] = useState(false);
  const [test, setTest] = useState<ConnectTest>({ state: 'idle' });
  const [checked, setChecked] = useState<string[]>([]);
  const [extra, setExtra] = useState<CatalogPick[]>([]);
  const [another, setAnother] = useState('');
  const [typedAliases, setTypedAliases] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<ModelRegistryProviderRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entry = settingsProviderType(draft.catalogId);
  const fields = connectFields(entry);
  const blocker = connectBlocker(draft, fields, takenKeys);
  const picks = [...catalogPicks(catalogQuery.data, entry), ...extra];
  const chosen = picks.filter((p) => checked.includes(p.modelId));
  const aliases = previewAliases(
    chosen.map((p) => p.modelId),
    draft.id.trim(),
    existingAliases,
    typedAliases,
  );

  function edit(patch: Partial<ConnectDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setTest({ state: 'idle' });
  }

  function chooseType(catalogId: SettingsProviderType['id']) {
    const next = initialDraft(catalogId, takenKeys);
    setDraft((d) => ({ ...next, id: idEdited ? d.id : next.id }));
    setTest({ state: 'idle' });
    setChecked([]);
    setExtra([]);
    setTypedAliases({});
  }

  async function runTest() {
    // The button is not rendered for these (`connectFields(...).testable`).
    if ('untestable' in entry) return;
    setTest({ state: 'testing' });
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: entry.wiresAs,
        // The keyless types still need a non-empty key on the wire, exactly as
        // onboarding sends it (onboarding/steps/AuthStep.tsx).
        apiKey: fields.apiKey ? draft.apiKey.trim() : 'no-key',
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      });
      setTest(
        result.ok
          ? { state: 'ok', models: result.models?.length ?? null }
          : { state: 'error', error: result.error ?? 'The provider refused the connection.' },
      );
    } catch (err) {
      setTest({ state: 'error', error: messageOf(err) });
    }
  }

  function addAnother() {
    const idsToAdd = parseModelIds(
      another,
      picks.map((p) => p.modelId),
    );
    if (idsToAdd.length === 0) return;
    setExtra((e) => [
      ...e,
      ...idsToAdd.map((modelId) => ({ modelId, label: modelId, contextWindow: null })),
    ]);
    setChecked((c) => [...c, ...idsToAdd]);
    setAnother('');
  }

  async function save() {
    setSaving(true);
    setRefusal(null);
    setError(null);
    try {
      const result = await rpc.modelRegistry.addProvider(
        addProviderRequest({ entry, fields, draft, models: chosen, aliases }),
      );
      if (result.ok) onAdded(result);
      else setRefusal(result);
    } catch (err) {
      setError(`Could not add the provider: ${messageOf(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const connected = test.state === 'ok' || test.state === 'signed-in';
  const addLabel =
    chosen.length === 0
      ? 'Add provider'
      : `Add provider and ${chosen.length} model${chosen.length === 1 ? '' : 's'}`;

  const footer =
    step === 1 ? (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={onClose}>Cancel</Button>
        {connected ? (
          <Button type="primary" onClick={() => setStep(2)}>
            Continue
          </Button>
        ) : (
          <>
            <Button disabled={blocker !== null} onClick={() => setStep(2)}>
              Continue without testing
            </Button>
            {fields.testable ? (
              <Button
                type="primary"
                disabled={blocker !== null}
                loading={test.state === 'testing'}
                onClick={() => void runTest()}
              >
                Test connection
              </Button>
            ) : null}
          </>
        )}
      </div>
    ) : (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => setStep(1)}>Back</Button>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          {addLabel}
        </Button>
      </div>
    );

  return (
    <Drawer
      open
      className="add-provider-drawer"
      title="Add provider"
      onClose={onClose}
      width={480}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>
          <span style={step === 1 ? { color: 'var(--text-primary)', fontWeight: 500 } : undefined}>
            1 Connect
          </span>
          <span>→</span>
          <span style={step === 2 ? { color: 'var(--text-primary)', fontWeight: 500 } : undefined}>
            2 Choose models
          </span>
        </div>

        {step === 1 ? (
          <>
            <div style={ROW}>
              <label htmlFor={`${ids}-type`} style={LABEL}>
                Type
              </label>
              <Select
                id={`${ids}-type`}
                value={draft.catalogId}
                onChange={(value: SettingsProviderType['id']) => chooseType(value)}
                options={SETTINGS_PROVIDER_TYPES.map((p) => ({
                  value: p.id,
                  label: (
                    <span style={OPTION}>
                      <span>{p.label}</span>
                      <span style={{ ...HINT, ...MONO }}>{p.id}</span>
                    </span>
                  ),
                }))}
              />
              <span style={HINT}>{entry.description}</span>
            </div>

            <div style={ROW}>
              <label htmlFor={`${ids}-id`} style={LABEL}>
                Id
              </label>
              <Input
                id={`${ids}-id`}
                value={draft.id}
                style={MONO}
                onChange={(e) => {
                  setIdEdited(true);
                  edit({ id: e.target.value });
                }}
              />
              <span style={HINT}>What models name as their provider. Can't be changed later.</span>
            </div>

            {fields.apiKey ? (
              <div style={ROW}>
                <label htmlFor={`${ids}-key`} style={LABEL}>
                  API key
                </label>
                <Input.Password
                  id={`${ids}-key`}
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={(e) => edit({ apiKey: e.target.value })}
                />
                <span style={HINT}>Stored in the secret store, not in config.yaml.</span>
              </div>
            ) : null}

            {fields.baseUrl !== null ? (
              <div style={ROW}>
                <label htmlFor={`${ids}-base`} style={LABEL}>
                  Base URL
                </label>
                <Input
                  id={`${ids}-base`}
                  value={draft.baseUrl}
                  style={MONO}
                  placeholder={entry.baseUrl?.default ?? 'https://api.example.com/v1'}
                  onChange={(e) => edit({ baseUrl: e.target.value })}
                />
              </div>
            ) : null}

            {providerExtraFields(entry.wiresAs).map((spec) => (
              <div key={spec.field} style={ROW}>
                <label htmlFor={`${ids}-${spec.field}`} style={LABEL}>
                  {spec.label}
                </label>
                <Input
                  id={`${ids}-${spec.field}`}
                  value={draft.extras?.[spec.field] ?? ''}
                  style={MONO}
                  placeholder={spec.placeholder}
                  onChange={(e) =>
                    edit({ extras: { ...draft.extras, [spec.field]: e.target.value } })
                  }
                />
                <span style={HINT}>{spec.hint}</span>
              </div>
            ))}

            {entry.authType === 'aws-credentials' ? (
              <span style={HINT}>
                No API key. Requests are signed with the keys stored at{' '}
                <span style={MONO}>providers/bedrock/accessKeyId</span> and{' '}
                <span style={MONO}>providers/bedrock/secretAccessKey</span> when both are set,
                otherwise with the AWS credential chain (an IAM role, or the AWS profile above).
              </span>
            ) : null}

            {fields.deviceAuth ? (
              <CodexSignIn onSignedIn={() => setTest({ state: 'signed-in' })} />
            ) : null}

            {blocker !== null && draft.id.trim() !== '' ? (
              <span style={HINT}>{blocker}</span>
            ) : null}
            <ConnectResult test={test} />
          </>
        ) : (
          <>
            <div style={ROW}>
              <span style={LABEL}>Provider</span>
              <span style={{ fontSize: 13 }}>
                <span style={MONO}>{draft.id.trim()}</span>{' '}
                <span style={HINT}>
                  {entry.id} · {connected ? '✓ connected' : 'not tested'}
                </span>
              </span>
            </div>

            <div style={ROW}>
              <span style={LABEL}>Models from the catalog</span>
              {picks.length === 0 ? (
                <span style={HINT}>
                  The catalog lists no models for {entry.label}. Add a model id below.
                </span>
              ) : (
                <div className="add-provider-models">
                  {picks.map((p) => (
                    <div key={p.modelId} style={CHECK_ROW}>
                      <Checkbox
                        aria-label={`Add ${p.modelId}`}
                        checked={checked.includes(p.modelId)}
                        onChange={(e) =>
                          setChecked((c) =>
                            e.target.checked
                              ? [...c, p.modelId]
                              : c.filter((id) => id !== p.modelId),
                          )
                        }
                      />
                      <span style={{ ...MONO, overflowWrap: 'anywhere' }}>{p.modelId}</span>
                      <span style={{ ...HINT, ...MONO }}>
                        {p.contextWindow !== null ? formatContextWindow(p.contextWindow) : 'typed'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={ROW}>
              <label htmlFor={`${ids}-another`} style={LABEL}>
                Another model id
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <Input
                  id={`${ids}-another`}
                  value={another}
                  style={MONO}
                  placeholder="an id the catalog doesn't list"
                  onChange={(e) => setAnother(e.target.value)}
                  onPressEnter={addAnother}
                />
                <Button onClick={addAnother} disabled={another.trim() === ''}>
                  Add
                </Button>
              </div>
              <span style={HINT}>Separate several ids with spaces or commas.</span>
            </div>

            {chosen.length > 0 ? (
              <div style={ROW}>
                <span style={LABEL}>Aliases</span>
                {chosen.map((p) => (
                  <div key={p.modelId} style={ALIAS_ROW}>
                    <span style={{ ...MONO, fontSize: 12, overflowWrap: 'anywhere' }}>
                      {p.modelId}
                    </span>
                    <Input
                      size="small"
                      aria-label={`Alias for ${p.modelId}`}
                      value={typedAliases[p.modelId] ?? aliases[p.modelId] ?? ''}
                      style={MONO}
                      onChange={(e) =>
                        setTypedAliases((t) => ({ ...t, [p.modelId]: e.target.value }))
                      }
                    />
                  </div>
                ))}
                <span style={HINT}>
                  Prefilled from the id. If an alias is already taken, the provider id is appended.
                </span>
              </div>
            ) : null}

            {refusal ? (
              <>
                <RefusalNotice refusal={refusal} />
                {refusal.aliases.length > 0 ? (
                  <span style={HINT}>
                    Aliases: <span style={MONO}>{refusal.aliases.join(', ')}</span>
                  </span>
                ) : null}
              </>
            ) : null}
            {error ? (
              <span role="alert" style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--error)' }}>✗ </span>
                {error}
              </span>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

function initialDraft(
  catalogId: SettingsProviderType['id'],
  takenKeys: readonly string[],
): ConnectDraft {
  return {
    catalogId,
    id: uniqueProviderId(catalogId, takenKeys),
    apiKey: '',
    baseUrl: settingsProviderType(catalogId).baseUrl?.default ?? '',
  };
}

function ConnectResult({ test }: { test: ConnectTest }) {
  switch (test.state) {
    case 'idle':
    case 'signed-in':
      return null;
    case 'testing':
      return <span style={HINT}>Testing the connection…</span>;
    case 'ok':
      return (
        <span role="status" style={{ fontSize: 13, color: 'var(--success)' }}>
          ✓ Connected
          {test.models !== null ? (
            <span style={HINT}>
              {' '}
              · {test.models} model{test.models === 1 ? '' : 's'} available
            </span>
          ) : null}
        </span>
      );
    case 'error':
      return (
        <span role="alert" style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--error)' }}>✗ </span>
          {test.error}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Codex device sign-in — the same `/auth/codex/*` endpoints onboarding's
// DeviceAuthFlow uses. The replies are external JSON, so they are parsed, not cast.
// ---------------------------------------------------------------------------

const DeviceCodeReply = z.object({
  ok: z.boolean(),
  userCode: z.string().optional(),
  sessionToken: z.string().optional(),
  error: z.string().optional(),
});

const DeviceStatusReply = z.object({
  ok: z.boolean(),
  authorized: z.boolean().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

const POLL_MS = 5_000;
const RATE_LIMITED_POLL_MS = 30_000;

type SignIn =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

function CodexSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<SignIn>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function poll(session: string) {
    try {
      const res = await fetch(`/auth/codex/status?session=${encodeURIComponent(session)}`);
      const reply = DeviceStatusReply.safeParse(await res.json());
      if (!reply.success) {
        setState({ phase: 'error', message: 'The sign-in status could not be read.' });
        return;
      }
      if (reply.data.code === 'rate_limited') {
        timer.current = setTimeout(() => void poll(session), RATE_LIMITED_POLL_MS);
        return;
      }
      if (reply.data.authorized) {
        setState({ phase: 'done' });
        onSignedIn();
        return;
      }
      if (!reply.data.ok) {
        setState({ phase: 'error', message: reply.data.error ?? 'Sign-in failed.' });
        return;
      }
      timer.current = setTimeout(() => void poll(session), POLL_MS);
    } catch (err) {
      setState({ phase: 'error', message: messageOf(err) });
    }
  }

  async function start() {
    setState({ phase: 'starting' });
    try {
      const res = await fetch('/auth/codex/device-code', { method: 'POST' });
      const reply = DeviceCodeReply.safeParse(await res.json());
      if (!reply.success || !reply.data.ok || !reply.data.userCode || !reply.data.sessionToken) {
        const message = reply.success ? reply.data.error : undefined;
        setState({ phase: 'error', message: message ?? 'Could not start the sign-in.' });
        return;
      }
      setState({ phase: 'waiting', userCode: reply.data.userCode });
      const session = reply.data.sessionToken;
      timer.current = setTimeout(() => void poll(session), POLL_MS);
    } catch (err) {
      setState({ phase: 'error', message: messageOf(err) });
    }
  }

  return (
    <div style={ROW}>
      <span style={LABEL}>Sign in</span>
      {state.phase === 'idle' || state.phase === 'starting' ? (
        <>
          <div>
            <Button loading={state.phase === 'starting'} onClick={() => void start()}>
              Sign in with ChatGPT
            </Button>
          </div>
          <span style={HINT}>Codex runs on your ChatGPT account. No API key.</span>
        </>
      ) : null}
      {state.phase === 'waiting' ? (
        <span style={{ fontSize: 13 }}>
          Open{' '}
          <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">
            auth.openai.com/codex/device
          </a>{' '}
          and enter <strong style={MONO}>{state.userCode}</strong>. Waiting for you to approve…
        </span>
      ) : null}
      {state.phase === 'done' ? (
        <span role="status" style={{ fontSize: 13, color: 'var(--success)' }}>
          ✓ Signed in
        </span>
      ) : null}
      {state.phase === 'error' ? (
        <span role="alert" style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--error)' }}>✗ </span>
          {state.message}{' '}
          <Button size="small" onClick={() => void start()}>
            Try again
          </Button>
        </span>
      ) : null}
    </div>
  );
}
