import { useEffect, useState } from 'react';
import type { ConfigGetResponse, ProviderType } from '../../../shared/ipc-contract';
import { SectionLabel } from '../../ui/SectionLabel';
import { SettingRow } from '../../ui/SettingRow';
import { ApiKeyUpdateFlow } from '../components/ApiKeyUpdateFlow';
import { ProviderDropdown } from '../components/ProviderDropdown';
import { SaveButton } from '../components/SaveButton';

interface ProviderTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

const PROVIDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openrouter', label: 'OpenRouter' },
];

export function ProviderTab({ config, onRefresh }: ProviderTabProps) {
  const [provider, setProvider] = useState<ProviderType>(config.provider);
  const [model, setModel] = useState(config.model);
  const [compressionModel, setCompressionModel] = useState(config.compressionModel ?? '');
  const [visionModel, setVisionModel] = useState(config.visionModel ?? '');
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? '');
  const [keyPreview, setKeyPreview] = useState(config.apiKeyPreview ?? '');

  useEffect(() => {
    setProvider(config.provider);
    setModel(config.model);
    setCompressionModel(config.compressionModel ?? '');
    setVisionModel(config.visionModel ?? '');
    setBaseUrl(config.baseUrl ?? '');
    setKeyPreview(config.apiKeyPreview ?? '');
  }, [config]);

  const models = config.providers[provider] ?? [];
  const modelOptions = models.map((m) => ({ value: m, label: m }));
  const showEndpoint = provider === 'ollama' || provider === 'azure' || provider === 'openrouter';

  const hasChanges =
    provider !== config.provider ||
    model !== config.model ||
    compressionModel !== (config.compressionModel ?? '') ||
    visionModel !== (config.visionModel ?? '') ||
    baseUrl !== (config.baseUrl ?? '');

  async function handleSave(): Promise<{ ok: boolean; error?: string }> {
    const updates: Record<string, unknown> = {};
    if (provider !== config.provider) updates.provider = provider;
    if (model !== config.model) updates.model = model;
    if (compressionModel !== (config.compressionModel ?? ''))
      updates.compressionModel = compressionModel || undefined;
    if (visionModel !== (config.visionModel ?? '')) updates.visionModel = visionModel || undefined;
    if (baseUrl !== (config.baseUrl ?? '')) updates.baseUrl = baseUrl || undefined;

    const result = await window.ethos.settings.updateConfig(updates);
    if (result.ok) {
      onRefresh();
    }
    return result;
  }

  async function refreshKeyPreview() {
    try {
      const { preview } = await window.ethos.keychain.preview({ key: 'api-key' });
      setKeyPreview(preview ?? '');
    } catch {
      // ignore
    }
    onRefresh();
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Active provider</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SettingRow label="Provider">
            <ProviderDropdown
              value={provider}
              options={PROVIDER_OPTIONS}
              onChange={(v) => {
                setProvider(v as ProviderType);
                const providerModels = config.providers[v] ?? [];
                setModel(providerModels[0] ?? '');
                setCompressionModel('');
                setVisionModel('');
              }}
            />
          </SettingRow>

          <SettingRow label="Model">
            <ProviderDropdown value={model} options={modelOptions} onChange={setModel} mono />
          </SettingRow>

          <SettingRow label="Compression model" subText="Used for session summaries">
            <ProviderDropdown
              value={compressionModel}
              options={[{ value: '', label: 'Default' }, ...modelOptions]}
              onChange={setCompressionModel}
              mono
            />
          </SettingRow>

          <SettingRow label="Vision model" subText="Used for image inputs">
            <ProviderDropdown
              value={visionModel}
              options={[{ value: '', label: 'Default' }, ...modelOptions]}
              onChange={setVisionModel}
              mono
            />
          </SettingRow>

          {showEndpoint && (
            <SettingRow label="Endpoint URL">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://..."
                style={{
                  width: 280,
                  height: 32,
                  padding: '0 8px',
                  borderRadius: 4,
                  border: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  outline: 'none',
                }}
              />
            </SettingRow>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>API Key</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SettingRow label="Current key">
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              {keyPreview || 'Not set'}
            </span>
          </SettingRow>
          <ApiKeyUpdateFlow provider={provider} onKeyUpdated={refreshKeyPreview} />
        </div>
      </div>

      <SaveButton disabled={!hasChanges} onSave={handleSave} />
    </div>
  );
}
