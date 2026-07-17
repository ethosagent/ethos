import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

type Platform = 'telegram' | 'discord' | 'slack' | 'email' | 'skip';

interface PlatformEntry {
  id: Platform;
  label: string;
  hint: string;
}

const PLATFORMS: PlatformEntry[] = [
  { id: 'telegram', label: 'Telegram', hint: 'bot token from @BotFather' },
  { id: 'discord', label: 'Discord', hint: 'bot token from Discord Developer Portal' },
  { id: 'slack', label: 'Slack', hint: 'bot token + app token + signing secret' },
  { id: 'email', label: 'Email (IMAP/SMTP)', hint: 'IMAP + SMTP credentials' },
  { id: 'skip', label: 'Skip', hint: 'chat in your browser via `ethos serve`' },
];

type Phase = 'select' | 'configure' | 'validating' | 'validated';

interface FieldDef {
  key: string;
  label: string;
  sensitive: boolean;
}

// W2.6 honesty split — a never-probed credential must never render "Connected".
//   ok          → validator confirmed the token (renders "✓ Connected")
//   rejected    → 401/403, definitively bad (no save-anyway path)
//   unreachable → outage; saved unverified and allowed through (W1.2)
//   unvalidated → module-missing or email; saved but never probed
type PlatformValidation =
  | { kind: 'ok'; label?: string }
  | { kind: 'rejected'; error: string }
  | { kind: 'unreachable'; error: string }
  | { kind: 'unvalidated' };

function getFields(platform: Platform): FieldDef[] {
  switch (platform) {
    case 'telegram':
      return [{ key: 'telegramToken', label: 'Bot token', sensitive: true }];
    case 'discord':
      return [{ key: 'discordToken', label: 'Bot token', sensitive: true }];
    case 'slack':
      return [
        { key: 'slackBotToken', label: 'Bot token (xoxb-...)', sensitive: true },
        { key: 'slackAppToken', label: 'App token (xapp-...)', sensitive: true },
        { key: 'slackSigningSecret', label: 'Signing secret', sensitive: true },
      ];
    case 'email':
      return [
        { key: 'emailImapHost', label: 'IMAP host', sensitive: false },
        { key: 'emailUser', label: 'Email address', sensitive: false },
        { key: 'emailPassword', label: 'Password', sensitive: true },
        { key: 'emailSmtpHost', label: 'SMTP host', sensitive: false },
      ];
    default:
      return [];
  }
}

function classify(result: {
  ok: boolean;
  label?: string;
  error?: string;
  // `unverified` (rate-limited) is treated as unreachable here — saved but
  // never claimed "Connected".
  reason?: 'rejected' | 'unreachable' | 'unverified';
}): PlatformValidation {
  if (result.ok) return { kind: 'ok', label: result.label };
  if (result.reason === 'rejected')
    return { kind: 'rejected', error: result.error ?? 'Invalid token' };
  return { kind: 'unreachable', error: result.error ?? 'Could not reach platform' };
}

async function validatePlatform(
  platform: Platform,
  values: Record<string, string>,
): Promise<PlatformValidation> {
  try {
    if (platform === 'telegram') {
      const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
      return classify(await validateTelegramToken(values.telegramToken ?? ''));
    }
    if (platform === 'discord') {
      const { validateDiscordToken } = await import('@ethosagent/platform-discord/validate');
      return classify(await validateDiscordToken(values.discordToken ?? ''));
    }
    if (platform === 'slack') {
      const { validateSlackToken } = await import('@ethosagent/platform-slack/validate');
      return classify(await validateSlackToken(values.slackBotToken ?? ''));
    }
  } catch {
    // Validator module not available — save but never claim "Connected".
    return { kind: 'unvalidated' };
  }
  // email: no live validation (IMAP open is too slow for a wizard step).
  return { kind: 'unvalidated' };
}

export function MessagingStep() {
  const { accent, dispatch } = useWizardContext();
  const [phase, setPhase] = useState<Phase>('select');
  const [selected, setSelected] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [activeField, setActiveField] = useState(0);
  const [validation, setValidation] = useState<PlatformValidation | null>(null);

  const selectedPlatform = PLATFORMS[selected];

  // Run validation when phase transitions to 'validating'
  useEffect(() => {
    if (phase !== 'validating' || !selectedPlatform) return;
    let cancelled = false;
    validatePlatform(selectedPlatform.id, fieldValues).then((result) => {
      if (!cancelled) {
        setValidation(result);
        setPhase('validated');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [phase, selectedPlatform, fieldValues]);

  useInput((input, key) => {
    if (phase === 'select') {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(PLATFORMS.length - 1, s + 1));
      if (key.return) {
        const p = PLATFORMS[selected];
        if (!p) return;
        if (p.id === 'skip') {
          dispatch({ type: 'next', patch: {} });
        } else {
          setPhase('configure');
          setActiveField(0);
          setFieldValues({});
          setValidation(null);
        }
      }
      if (key.escape) dispatch({ type: 'back' });
    } else if (phase === 'configure') {
      const fields = getFields(selectedPlatform?.id ?? 'skip');
      const currentFieldKey = fields[activeField]?.key ?? '';
      if (key.escape) {
        setPhase('select');
        return;
      }
      if (key.return) {
        if (activeField < fields.length - 1) {
          setActiveField((f) => f + 1);
        } else {
          // All fields filled — validate
          setPhase('validating');
        }
        return;
      }
      if (key.backspace || key.delete) {
        setFieldValues((v) => ({
          ...v,
          [currentFieldKey]: (v[currentFieldKey] ?? '').slice(0, -1),
        }));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setFieldValues((v) => ({ ...v, [currentFieldKey]: (v[currentFieldKey] ?? '') + input }));
      }
    } else if (phase === 'validated') {
      const rejected = validation?.kind === 'rejected';
      // No save-anyway path for a DEFINITIVELY rejected credential (W2.6):
      // Enter is inert; the only ways forward are re-enter (Esc) or skip (S).
      if (key.return && !rejected) {
        // Carry the validated Telegram @username forward so the LaunchStep can
        // gate the "Start the Telegram bot now" option and print the success
        // block with the real handle (W2.5).
        const telegramUsername =
          selectedPlatform?.id === 'telegram' && validation?.kind === 'ok'
            ? validation.label
            : undefined;
        dispatch({
          type: 'next',
          patch: telegramUsername ? { ...fieldValues, telegramUsername } : fieldValues,
        });
      }
      if (rejected && (input === 's' || input === 'S')) {
        // Skip this platform — advance without saving the rejected credential.
        dispatch({ type: 'next', patch: {} });
      }
      if (key.escape) {
        setPhase('configure');
        setActiveField(0);
      }
    }
  });

  if (phase === 'select') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Connect a messaging platform:
        </Text>
        <Box flexDirection="column">
          {PLATFORMS.map((p, i) => {
            const isSelected = i === selected;
            const cursor = isSelected ? GLYPHS.prompt : ' ';
            const isSkip = p.id === 'skip';
            return (
              <Box key={p.id} flexDirection="row" gap={1}>
                <Text color={isSelected ? accent : DESIGN.textTertiary}>{` ${cursor} `}</Text>
                <Text
                  color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                  bold={isSelected}
                >
                  {p.label.padEnd(20)}
                </Text>
                <Text color={isSkip && isSelected ? accent : DESIGN.textTertiary}>{p.hint}</Text>
              </Box>
            );
          })}
        </Box>
        <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  if (phase === 'validating') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`Validating ${selectedPlatform?.label ?? ''}...`}
        </Text>
        <Text color={DESIGN.textTertiary}>{'  Checking credentials (3s timeout)'}</Text>
      </Box>
    );
  }

  if (phase === 'validated' && validation) {
    const platformLabel = selectedPlatform?.label ?? '';
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`${platformLabel} credentials:`}
        </Text>

        {validation.kind === 'ok' && (
          <>
            <Text color={DESIGN.success}>
              {`  ${GLYPHS.toolOk} Connected${validation.label ? ` · ${validation.label}` : ''}`}
            </Text>
            <Text color={DESIGN.textTertiary}>{'  Enter to continue'}</Text>
          </>
        )}

        {validation.kind === 'unvalidated' && (
          <>
            <Text color={DESIGN.success}>{`  ${GLYPHS.toolOk} Saved (not validated)`}</Text>
            <Text color={DESIGN.textTertiary}>{'  Enter to continue'}</Text>
          </>
        )}

        {validation.kind === 'unreachable' && (
          <Text color={DESIGN.warning}>
            {`  Couldn't reach ${platformLabel} — saved unverified. Enter to continue`}
          </Text>
        )}

        {validation.kind === 'rejected' && (
          <Text color={DESIGN.error}>
            {'  Token rejected — Esc to re-enter, S to skip this platform'}
          </Text>
        )}
      </Box>
    );
  }

  // configure phase
  const fields = getFields(selectedPlatform?.id ?? 'skip');
  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {`Configure ${selectedPlatform?.label ?? ''}:`}
      </Text>
      <Box flexDirection="column">
        {fields.map((f, i) => {
          const isActive = i === activeField;
          const isDone = i < activeField;
          const value = fieldValues[f.key] ?? '';
          const maskedValue =
            f.sensitive && value.length > 0
              ? `${'•'.repeat(Math.min(value.length, 20))}${value.length > 20 ? ` (${value.length} chars)` : ''}`
              : value;
          return (
            <Box key={f.key} flexDirection="row" gap={1}>
              <Text color={isDone ? DESIGN.success : isActive ? accent : DESIGN.textTertiary}>
                {isDone ? `  ${GLYPHS.toolOk} ` : isActive ? `  ${GLYPHS.prompt} ` : '    '}
              </Text>
              <Text color={isDone ? DESIGN.textSecondary : DESIGN.textPrimary}>
                {`${f.label}: `}
              </Text>
              {isActive ? (
                <Text color={maskedValue ? DESIGN.textPrimary : DESIGN.textTertiary}>
                  {maskedValue || '(type here)'}
                </Text>
              ) : isDone ? (
                <Text color={DESIGN.textTertiary}>{maskedValue || '—'}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  Enter next field   Esc back to platform select'}</Text>
    </Box>
  );
}
