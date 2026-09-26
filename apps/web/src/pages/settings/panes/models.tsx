// Models & providers — providers & models (one list, each provider with its
// models beneath it), decision models, catalog & backends, auxiliary models,
// per-personality routing. Off `Card`, onto `SettingRow` (§4.2 rows 1, 10, 16;
// plan Phase 3).
//
// Decision models saves ON ITS OWN through `decisions.*` (the provider key; a
// site's mode is config.yaml-only and shown read-only).
// Providers & models and per-personality routing save ON THEIR OWN through
// `modelRegistry.*` (plan/phases/model-registry.md T2.3, T2.7, and the approved
// "Providers & models" mockup). Nothing in them is on the page Save:
// `buildConfigPatch` sends no `providers`. Catalog & backends and auxiliary
// models stay on the page Save.

import { Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { DecisionModelsSection } from '../components/decision-models-section';
import { ModelRegistrySection } from '../components/model-registry-section';
import { ModelRoutingSection } from '../components/model-routing-section';
import { ROW_BOX_STYLE } from '../components/primitives';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { useSettingsPane } from '../pane-context';

export function ModelsPane() {
  const { config: configData, personalities } = useSettingsPane();

  return (
    <>
      <SectionHeading id="models">providers & models</SectionHeading>
      <ModelRegistrySection />

      <SectionHeading id="decision-models">decision models</SectionHeading>
      <DecisionModelsSection />

      <AdvancedBlock>
        <SectionHeading id="catalog-and-backends">catalog & backends</SectionHeading>
        <CatalogAndBackendsFields />
      </AdvancedBlock>

      <AdvancedBlock>
        <SectionHeading id="auxiliary-models">auxiliary models</SectionHeading>
        <AuxiliaryModelsFields
          auxPreviews={{
            compression: configData?.auxCompression.apiKeyPreview ?? null,
            vision: configData?.auxVision.apiKeyPreview ?? null,
            web: configData?.auxWeb.apiKeyPreview ?? null,
          }}
        />
      </AdvancedBlock>

      <AdvancedBlock>
        <SectionHeading id="per-personality-routing">per-personality routing</SectionHeading>
        <ModelRoutingSection personalityIds={personalities.map((p) => p.id)} />
      </AdvancedBlock>
    </>
  );
}

// ---------------------------------------------------------------------------
// Catalog & backends (advanced) — model catalog + web tool backend selection.
// ---------------------------------------------------------------------------

function CatalogAndBackendsFields() {
  return (
    <>
      <SettingRow
        label="Remote model catalog"
        formName="modelCatalog.enabled"
        help="Fetch the remote model catalog for model pickers (default on)."
      >
        <Form.Item
          name={['modelCatalog', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Catalog URL"
        formName="modelCatalog.url"
        help="Override the catalog endpoint. Blank = built-in endpoint."
      >
        <Form.Item name={['modelCatalog', 'url']} style={{ marginBottom: 0 }}>
          <Input placeholder="https://…" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Catalog TTL (hours)"
        formName="modelCatalog.ttlHours"
        help="Cache lifetime for the fetched catalog (default 24)."
      >
        <Form.Item name={['modelCatalog', 'ttlHours']} style={{ marginBottom: 0 }}>
          <InputNumber min={0.1} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Web search backend"
        formName="webSearchBackend"
        help="Auto picks from available keys. Saved with this page; the key each backend uses is bound in the Web-search defaults section, under Security & access, which saves on its own button."
      >
        <Form.Item name="webSearchBackend" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: '', label: 'Auto' },
              { value: 'exa', label: 'Exa' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'brave', label: 'Brave' },
            ]}
          />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Web extract backend" formName="webExtractBackend">
        <Form.Item name="webExtractBackend" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: '', label: 'Auto' },
              { value: 'htmltext', label: 'htmltext' },
            ]}
          />
        </Form.Item>
      </SettingRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// Auxiliary models (advanced) — the three auxiliary model slots. API keys are
// write-only (preview shown).
// ---------------------------------------------------------------------------

function AuxModelFieldGroup({
  slot,
  label,
  help,
  preview,
}: {
  slot: 'auxCompression' | 'auxVision' | 'auxWeb';
  label: string;
  help: string;
  preview: string | null;
}) {
  return (
    <div style={ROW_BOX_STYLE}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
        {help} Blank fields fall back to the primary provider.
      </Typography.Paragraph>
      <SettingRow label="Model" formName={`${slot}.model`}>
        <Form.Item name={[slot, 'model']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="claude-haiku-4-5-20251001" />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Provider" formName={`${slot}.provider`}>
        <Form.Item name={[slot, 'provider']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="anthropic | openrouter | ollama" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="API key"
        formName={`${slot}.apiKey`}
        help={preview ? `Current: ${preview} — sent only when you type a new key.` : undefined}
      >
        <Form.Item name={[slot, 'apiKey']} style={{ marginBottom: 0 }}>
          <Input.Password
            size="small"
            autoComplete="off"
            placeholder={preview ?? 'paste new key'}
          />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Base URL" formName={`${slot}.baseUrl`}>
        <Form.Item name={[slot, 'baseUrl']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="https://openrouter.ai/api/v1" />
        </Form.Item>
      </SettingRow>
    </div>
  );
}

function AuxiliaryModelsFields({
  auxPreviews,
}: {
  auxPreviews: { compression: string | null; vision: string | null; web: string | null };
}) {
  return (
    <>
      <AuxModelFieldGroup
        slot="auxCompression"
        label="Compression model"
        help="Summarizer used for context compaction (auxiliary.compression.*)."
        preview={auxPreviews.compression}
      />
      <AuxModelFieldGroup
        slot="auxVision"
        label="Vision model"
        help="Fallback for image inputs when the primary model lacks vision (auxiliary.vision.*)."
        preview={auxPreviews.vision}
      />
      <AuxModelFieldGroup
        slot="auxWeb"
        label="Web summarizer"
        help="Summarizer for web_extract output (auxiliary.web.*)."
        preview={auxPreviews.web}
      />
    </>
  );
}
