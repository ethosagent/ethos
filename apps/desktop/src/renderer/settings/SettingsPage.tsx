import { useCallback, useEffect, useState } from 'react';
import type { ConfigGetResponse } from '../../shared/ipc-contract';
import type { SettingsTab } from './SettingsNav';
import { SettingsNav } from './SettingsNav';
import { AdvancedTab } from './tabs/AdvancedTab';
import { AppearanceTab } from './tabs/AppearanceTab';
import { GeneralTab } from './tabs/GeneralTab';
import { MemoryTab } from './tabs/MemoryTab';
import { ProviderTab } from './tabs/ProviderTab';
import { RetentionTab } from './tabs/RetentionTab';

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [config, setConfig] = useState<ConfigGetResponse | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await window.ethos.settings.getConfig();
      setConfig(cfg);
    } catch (err) {
      console.error('[SettingsPage] Failed to load config', err);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  if (!config) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}
      >
        Loading settings...
      </div>
    );
  }

  function renderTab() {
    if (!config) return null;
    switch (activeTab) {
      case 'general':
        return <GeneralTab config={config} onRefresh={loadConfig} />;
      case 'provider':
        return <ProviderTab config={config} onRefresh={loadConfig} />;
      case 'appearance':
        return <AppearanceTab config={config} onRefresh={loadConfig} />;
      case 'memory':
        return <MemoryTab config={config} onRefresh={loadConfig} />;
      case 'retention':
        return <RetentionTab config={config} onRefresh={loadConfig} />;
      case 'advanced':
        return <AdvancedTab config={config} onRefresh={loadConfig} />;
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <SettingsNav activeTab={activeTab} onTabChange={setActiveTab} />
      <div
        style={{
          flex: 1,
          maxWidth: 720,
          padding: 32,
          overflowY: 'auto',
        }}
      >
        {renderTab()}
      </div>
    </div>
  );
}
