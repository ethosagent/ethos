import { formatContextWindow, getModelsForProvider } from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, GLYPHS, personalityAccent } from '../../skin';
import { useWizardContext } from '../context';

const DIVIDER = '─'.repeat(52);
function Divider({ label }) {
  return _jsx(Text, {
    color: DESIGN.textTertiary,
    children: `${DIVIDER.slice(0, 2)} ${label} ${DIVIDER.slice(0, 52 - label.length - 4)}`,
  });
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
  return _jsxs(Box, {
    flexDirection: 'column',
    gap: 1,
    children: [
      _jsx(Divider, { label: 'summary' }),
      _jsxs(Box, {
        flexDirection: 'column',
        marginLeft: 2,
        children: [
          _jsx(Row, { label: 'Provider', value: providerLabel }),
          _jsx(Row, { label: 'Model', value: modelDisplay }),
          _jsx(PersonalityRow, { personality: personality, color: personalityColor }),
          messagingDisplay && _jsx(Row, { label: 'Messaging', value: messagingDisplay }),
        ],
      }),
      _jsxs(Box, {
        flexDirection: 'column',
        marginLeft: 2,
        marginTop: 1,
        children: [
          _jsx(Row, { label: 'Config', value: '~/.ethos/config.yaml' }),
          _jsx(Row, { label: 'Memory', value: '~/.ethos/MEMORY.md' }),
          _jsx(Row, { label: 'User', value: '~/.ethos/USER.md' }),
        ],
      }),
      _jsx(Divider, { label: 'useful commands' }),
      _jsxs(Box, {
        flexDirection: 'column',
        marginLeft: 2,
        children: [
          _jsx(Text, { color: DESIGN.textSecondary, children: 'ethos              start chat' }),
          _jsx(Text, {
            color: DESIGN.textSecondary,
            children: 'ethos doctor       runtime health check',
          }),
          _jsx(Text, {
            color: DESIGN.textSecondary,
            children: 'ethos gateway      add another platform',
          }),
          _jsx(Text, {
            color: DESIGN.textSecondary,
            children: 'ethos personality  switch personality',
          }),
        ],
      }),
      _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter next   Esc back' }),
    ],
  });
}
function Row({ label, value }) {
  return _jsxs(Box, {
    flexDirection: 'row',
    gap: 1,
    children: [
      _jsx(Text, { color: DESIGN.textPrimary, children: label.padEnd(12) }),
      _jsx(Text, { color: DESIGN.textSecondary, children: value }),
    ],
  });
}
function PersonalityRow({ personality, color }) {
  return _jsxs(Box, {
    flexDirection: 'row',
    gap: 1,
    children: [
      _jsx(Text, { color: DESIGN.textPrimary, children: 'Personality'.padEnd(12) }),
      _jsx(Text, { color: color, children: GLYPHS.accentStripe }),
      _jsx(Text, { color: color, children: ` ${personality}` }),
    ],
  });
}
function providerDisplayName(id) {
  const names = {
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
function buildMessagingDisplay(answers) {
  if (answers.telegramToken) return 'Telegram';
  if (answers.discordToken) return 'Discord';
  if (answers.slackBotToken) return 'Slack';
  if (answers.emailImapHost) return 'Email';
  return '';
}
