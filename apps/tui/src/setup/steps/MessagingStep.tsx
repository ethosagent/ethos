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

interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
}

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

async function validatePlatform(
  platform: Platform,
  values: Record<string, string>,
): Promise<ValidationResult> {
  try {
    if (platform === 'telegram') {
      const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
      return validateTelegramToken(values.telegramToken ?? '');
    }
    if (platform === 'discord') {
      const { validateDiscordToken } = await import('@ethosagent/platform-discord/validate');
      return validateDiscordToken(values.discordToken ?? '');
    }
    if (platform === 'slack') {
      const { validateSlackToken } = await import('@ethosagent/platform-slack/validate');
      return validateSlackToken(values.slackBotToken ?? '');
    }
  } catch {
    // Validator module not available — save anyway
    return { ok: true };
  }
  // email: no live validation (IMAP open is too slow for a wizard step)
  return { ok: true };
}

export function MessagingStep() {
  const { accent, dispatch } = useWizardContext();
  const [phase, setPhase] = useState<Phase>('select');
  const [selected, setSelected] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [activeField, setActiveField] = useState(0);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

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
      if (key.return) {
        dispatch({ type: 'next', patch: fieldValues });
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
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`${selectedPlatform?.label ?? ''} credentials:`}
        </Text>
        {validation.ok ? (
          <Text color={DESIGN.success}>
            {`  ${GLYPHS.toolOk} Connected${validation.label ? ` · ${validation.label}` : ''}`}
          </Text>
        ) : (
          <Text
            color={DESIGN.error}
          >{`  ${GLYPHS.toolFail} ${validation.error ?? 'Validation failed'}`}</Text>
        )}
        {!validation.ok && (
          <Text color={DESIGN.textTertiary}>
            {'  Esc to re-enter credentials   Enter to save anyway'}
          </Text>
        )}
        {validation.ok && <Text color={DESIGN.textTertiary}>{'  Enter to continue'}</Text>}
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
