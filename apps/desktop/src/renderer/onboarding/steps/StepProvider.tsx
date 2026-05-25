import { ProviderRow } from '../components/ProviderRow';

interface StepProviderProps {
  selectedProvider: string | null;
  onSelectProvider: (id: string) => void;
}

export function StepProvider({ selectedProvider, onSelectProvider }: StepProviderProps) {
  return (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Choose a provider
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 24 }}>
        Your API key is stored in your system keychain, not in any file.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ProviderRow
          name="Anthropic"
          description="Claude models"
          selected={selectedProvider === 'anthropic'}
          onSelect={() => onSelectProvider('anthropic')}
          badge={{ label: 'Recommended', variant: 'success' }}
        />
        <ProviderRow
          name="OpenAI"
          description="GPT-4o, o3"
          selected={selectedProvider === 'openai'}
          onSelect={() => onSelectProvider('openai')}
        />
        <ProviderRow
          name="OpenRouter"
          description="150+ models via one API"
          selected={selectedProvider === 'openrouter'}
          onSelect={() => onSelectProvider('openrouter')}
        />
        <ProviderRow
          name="Azure OpenAI"
          description="Azure-hosted OpenAI models"
          selected={selectedProvider === 'azure'}
          onSelect={() => onSelectProvider('azure')}
        />
      </div>
    </div>
  );
}
