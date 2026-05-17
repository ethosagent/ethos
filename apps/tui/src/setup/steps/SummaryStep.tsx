import { formatContextWindow, getModelsForProvider } from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { DESIGN, GLYPHS, personalityAccent } from '../../skin';
import { useWizardContext } from '../context';

const DIVIDER = '─'.repeat(52);

function Divider({ label }: { label: string }) {
  return (
    <Text
      color={DESIGN.textTertiary}
    >{`${DIVIDER.slice(0, 2)} ${label} ${DIVIDER.slice(0, 52 - label.length - 4)}`}</Text>
  );
}

export function SummaryStep() {
  const { answers, dispatch } = useWizardContext();

  useInput((_input, key) => {
    if (key.return) dispatch({ type: 'next', patch: {} });
    if (key.escape) dispatch({ type: 'back' });
  });

  const providerId = answers.provider ?? 'anthropic';
  const providerLabel = providerDisplayName(providerId);

  const models = getModelsForProvider(providerId);
  const modelEntry = models.find((m) => m.modelId === answers.model);
  const ctxStr = modelEntry ? formatContextWindow(modelEntry.contextWindow) : '';
  const modelDisplay = answers.model ? `${answers.model}${ctxStr ? `  ·  ${ctxStr}` : ''}` : '—';

  const personality = answers.personality ?? 'researcher';
  const personalityColor = personalityAccent(personality);

  const messagingDisplay = buildMessagingDisplay(answers);

  return (
    <Box flexDirection="column" gap={1}>
      <Divider label="summary" />

      <Box flexDirection="column" marginLeft={2}>
        <Row label="Provider" value={providerLabel} />
        <Row label="Model" value={modelDisplay} />
        <PersonalityRow personality={personality} color={personalityColor} />
        {messagingDisplay && <Row label="Messaging" value={messagingDisplay} />}
      </Box>

      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        <Row label="Config" value="~/.ethos/config.yaml" />
        <Row label="Memory" value="~/.ethos/MEMORY.md" />
        <Row label="User" value="~/.ethos/USER.md" />
      </Box>

      <Divider label="useful commands" />

      <Box flexDirection="column" marginLeft={2}>
        <Text color={DESIGN.textSecondary}>{'ethos              start chat'}</Text>
        <Text color={DESIGN.textSecondary}>{'ethos doctor       runtime health check'}</Text>
        <Text color={DESIGN.textSecondary}>{'ethos gateway      add another platform'}</Text>
        <Text color={DESIGN.textSecondary}>{'ethos personality  switch personality'}</Text>
      </Box>

      <Text color={DESIGN.textTertiary}>{'  Enter next   Esc back'}</Text>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={DESIGN.textPrimary}>{label.padEnd(12)}</Text>
      <Text color={DESIGN.textSecondary}>{value}</Text>
    </Box>
  );
}

function PersonalityRow({ personality, color }: { personality: string; color: string }) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={DESIGN.textPrimary}>{'Personality'.padEnd(12)}</Text>
      <Text color={color}>{GLYPHS.accentStripe}</Text>
      <Text color={color}>{` ${personality}`}</Text>
    </Box>
  );
}

function providerDisplayName(id: string): string {
  const names: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    gemini: 'Google Gemini',
    groq: 'Groq',
    deepseek: 'DeepSeek',
    ollama: 'Local (Ollama)',
    mistral: 'Mistral',
    together: 'Together AI',
    fireworks: 'Fireworks AI',
  };
  return names[id] ?? id;
}

function buildMessagingDisplay(answers: {
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  emailImapHost?: string;
}): string {
  if (answers.telegramToken) return 'Telegram';
  if (answers.discordToken) return 'Discord';
  if (answers.slackBotToken) return 'Slack';
  if (answers.emailImapHost) return 'Email';
  return '';
}
