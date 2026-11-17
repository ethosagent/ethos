import { InfoCircleOutlined } from '@ant-design/icons';
import type { Personality } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DecisionModelField } from '../../components/personality/DecisionModelField';
import type { DecisionFieldValue } from '../../components/personality/decisionModel';
import {
  decisionFieldValue,
  decisionsUpdateInput,
} from '../../components/personality/decisionModel';
import { ModelDeclarationSelect } from '../../components/personality/ModelDeclarationSelect';
import type { PersonalityVoice } from '../../components/personality/PersonalityVoiceFields';
import {
  PersonalityVoiceFields,
  voiceLanguageRows,
  voiceUpdateInput,
} from '../../components/personality/PersonalityVoiceFields';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { rpc } from '../../rpc';
import {
  BLANK_VOICE,
  FS_REACH_READ_HELP,
  FS_REACH_READ_PLACEHOLDER,
  FS_REACH_WORKDIR_HELP,
  FS_REACH_WORKDIR_PLACEHOLDER,
  FS_REACH_WRITE_HELP,
  MODEL_FIELD_HELP,
  NET_ALLOW_HELP,
  NET_DENY_HELP,
} from './shared';

export function ConfigEditor({
  id,
  personality,
  onDirtyChange,
}: {
  id: string;
  personality: Personality;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  // This form has ~30 fields across an Antd form, a separate voice block and a
  // tiered-model switch, so dirty is a latch set by any of the three rather
  // than a value comparison. It clears on a successful save and on the reset
  // the refetched personality drives.
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm<{
    name: string;
    description: string;
    capabilities: string[];
    fsReachRead: string[];
    fsReachWrite: string[];
    fsReachWorkdir: string[];
    netAllow: string[];
    netDeny: string[];
    dreaming: boolean;
    dreamingIdleMinutes: number;
    dreamingMaxPerDay: number;
    evolutionApprovalMode: 'auto' | 'user';
    skillEvolutionEnabled: boolean;
    skillEvolutionEvolveExisting: boolean;
    skillEvolutionPromotion: 'review' | 'auto';
    skillEvolutionScope: 'personality' | 'shared';
    skillEvolutionMinToolCalls: number;
    skillEvolutionCooldownMinutes: number;
    skillEvolutionModel: string;
    safetyApprovalMode: 'manual' | 'smart' | 'off';
    memoryProvider: string;
    nightlyEnabled: boolean;
    nightlyJudgeEnabled: boolean;
    nightlyJudgeMinInteractions: number;
    nightlyExpression: boolean;
  }>();
  // The model declaration lives outside the Antd form too. `null` = untouched:
  // the patch then omits `model`, and `update` keeps the stored value
  // (`patch.model ?? config.model` in FilePersonalityRegistry.update,
  // extensions/personalities/src/index.ts), so a tier map or an unrecognized
  // id survives a save of some other field.
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  // Voice lives outside the Antd form: `PersonalityVoiceFields` is a controlled
  // pair (the voice control switches between a select and free text as the
  // provider changes), and threading that through registered Form.Items buys
  // nothing but indirection.
  const [voice, setVoice] = useState<PersonalityVoice>(BLANK_VOICE);
  // Decision model + per-site modes, also outside the Antd form. `null` =
  // untouched: the patch then omits `decisions`, and the stored block is kept.
  const [decisions, setDecisions] = useState<DecisionFieldValue | null>(null);
  // The approver note reads the approval mode as the form holds it, unsaved.
  const approvalMode = Form.useWatch('safetyApprovalMode', form);

  useEffect(() => {
    setModelChoice(null);
    setDecisions(null);
    form.setFieldsValue({
      name: personality.name,
      description: personality.description ?? '',
      capabilities: personality.capabilities ?? [],
      fsReachRead: personality.fs_reach?.read ?? [],
      fsReachWrite: personality.fs_reach?.write ?? [],
      fsReachWorkdir: personality.fs_reach?.workdir ?? [],
      netAllow: personality.safety?.network?.allow ?? [],
      netDeny: personality.safety?.network?.deny ?? [],
      dreaming: personality.dreaming?.enable ?? false,
      dreamingIdleMinutes: personality.dreaming?.idleMinutes ?? 60,
      dreamingMaxPerDay: personality.dreaming?.maxPerDay ?? 1,
      evolutionApprovalMode: personality.evolution_approval_mode ?? 'user',
      skillEvolutionEnabled: personality.skill_evolution?.enabled ?? false,
      skillEvolutionEvolveExisting:
        personality.skill_evolution?.evolve_existing ??
        personality.skill_evolution?.enabled ??
        false,
      skillEvolutionPromotion: personality.skill_evolution?.promotion ?? 'review',
      skillEvolutionScope: personality.skill_evolution?.scope ?? 'shared',
      skillEvolutionMinToolCalls: personality.skill_evolution?.min_tool_calls ?? 3,
      skillEvolutionCooldownMinutes: personality.skill_evolution?.cooldown_minutes ?? 30,
      skillEvolutionModel: personality.skill_evolution?.model ?? '',
      safetyApprovalMode: personality.safety?.approvalMode ?? 'manual',
      memoryProvider: personality.memory?.provider ?? 'markdown',
      nightlyEnabled: personality.nightly?.enabled ?? true,
      nightlyJudgeEnabled: personality.nightly?.judge?.enabled ?? true,
      nightlyJudgeMinInteractions: personality.nightly?.judge?.minInteractions ?? 20,
      nightlyExpression: personality.nightly?.expression ?? true,
    });
    setVoice({
      ttsProvider: personality.voice?.tts_provider ?? '',
      ttsVoice: personality.voice?.tts_voice ?? '',
      sttProvider: personality.voice?.stt_provider ?? '',
      realtimeProvider: personality.voice?.realtime_provider ?? '',
      callStyle: personality.voice?.call_style ?? '',
      tier: personality.voice?.tier ?? '',
      model: personality.voice?.model ?? '',
      languages: voiceLanguageRows(personality.voice?.languages),
    });
    setDirty(false);
  }, [personality, form]);

  const mut = useMutation({
    mutationFn: (values: {
      name: string;
      description: string;
      capabilities: string[];
      fsReachRead: string[];
      fsReachWrite: string[];
      fsReachWorkdir: string[];
      netAllow: string[];
      netDeny: string[];
      dreaming: boolean;
      dreamingIdleMinutes: number;
      dreamingMaxPerDay: number;
      evolutionApprovalMode: 'auto' | 'user';
      skillEvolutionEnabled: boolean;
      skillEvolutionEvolveExisting: boolean;
      skillEvolutionPromotion: 'review' | 'auto';
      skillEvolutionScope: 'personality' | 'shared';
      skillEvolutionMinToolCalls: number;
      skillEvolutionCooldownMinutes: number;
      skillEvolutionModel: string;
      safetyApprovalMode: 'manual' | 'smart' | 'off';
      memoryProvider: string;
      nightlyEnabled: boolean;
      nightlyJudgeEnabled: boolean;
      nightlyJudgeMinInteractions: number;
      nightlyExpression: boolean;
    }) => {
      return rpc.personalities.update({
        id,
        name: values.name,
        description: values.description,
        // Omitted while untouched, so a stored tier map or vendor id is kept.
        // `provider` is never sent: it is not editable here (plan
        // model-registry D4), and an omitted `provider` keeps the stored value
        // (`patch.provider === undefined ? config.provider` in
        // FilePersonalityRegistry.update).
        ...(modelChoice !== null ? { model: modelChoice } : {}),
        capabilities: values.capabilities,
        // `workdir` is always sent, the empty LIST included: the registry
        // shallow-merges fs_reach sub-keys, so omitting it would preserve the
        // stored value and make the field impossible to clear from here.
        //
        // A list, not a string. The editor round-trips every declared root, so
        // saving a multi-root personality from this form no longer collapses
        // it to the first one.
        fs_reach: {
          read: values.fsReachRead,
          write: values.fsReachWrite,
          workdir: values.fsReachWorkdir,
        },
        dreaming: {
          enable: values.dreaming,
          idleMinutes: values.dreamingIdleMinutes,
          maxPerDay: values.dreamingMaxPerDay,
        },
        evolution_approval_mode: values.evolutionApprovalMode,
        skill_evolution: {
          enabled: values.skillEvolutionEnabled,
          evolve_existing: values.skillEvolutionEvolveExisting,
          promotion: values.skillEvolutionPromotion,
          scope: values.skillEvolutionScope,
          min_tool_calls: values.skillEvolutionMinToolCalls,
          cooldown_minutes: values.skillEvolutionCooldownMinutes,
          ...(values.skillEvolutionModel ? { model: values.skillEvolutionModel } : {}),
        },
        safety: {
          approvalMode: values.safetyApprovalMode,
          // An empty list is omitted rather than sent as `[]`: empty and absent
          // mean the same thing to the resolver, and a `network` object with no
          // lists is what clears the block back to none.
          //
          // `allow_private_urls` is echoed back untouched. It is not editable
          // here (localhost reach is a separate decision), and this patch
          // REPLACES the whole network block — dropping it would silently undo
          // a hand-written config.yaml.
          network: {
            ...(values.netAllow.length > 0 ? { allow: values.netAllow } : {}),
            ...(values.netDeny.length > 0 ? { deny: values.netDeny } : {}),
            ...(personality.safety?.network?.allow_private_urls !== undefined
              ? { allow_private_urls: personality.safety.network.allow_private_urls }
              : {}),
          },
        },
        memory: { provider: values.memoryProvider },
        // Every sub-key always sent, empty string included: the registry
        // shallow-merges the voice block, so omitting one would preserve the
        // stored value and make "back to the default provider" unexpressible.
        voice: voiceUpdateInput(voice),
        // Omitted while untouched, so a hand-written block is kept as written.
        ...(decisions !== null
          ? { decisions: decisionsUpdateInput(decisions, personality.decisions) }
          : {}),
        nightly: {
          enabled: values.nightlyEnabled,
          judge: {
            enabled: values.nightlyJudgeEnabled,
            minInteractions: values.nightlyJudgeMinInteractions,
          },
          expression: values.nightlyExpression,
        },
      });
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Config saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form
      form={form}
      layout="vertical"
      onValuesChange={() => setDirty(true)}
      onFinish={(values) =>
        mut.mutate({
          name: values.name,
          description: values.description,
          capabilities: values.capabilities ?? [],
          fsReachRead: values.fsReachRead ?? [],
          fsReachWrite: values.fsReachWrite ?? [],
          fsReachWorkdir: values.fsReachWorkdir ?? [],
          netAllow: values.netAllow ?? [],
          netDeny: values.netDeny ?? [],
          dreaming: values.dreaming ?? false,
          dreamingIdleMinutes: values.dreamingIdleMinutes ?? 60,
          dreamingMaxPerDay: values.dreamingMaxPerDay ?? 1,
          evolutionApprovalMode: values.evolutionApprovalMode ?? 'user',
          skillEvolutionEnabled: values.skillEvolutionEnabled ?? false,
          skillEvolutionEvolveExisting: values.skillEvolutionEvolveExisting ?? false,
          skillEvolutionPromotion: values.skillEvolutionPromotion ?? 'review',
          skillEvolutionScope: values.skillEvolutionScope ?? 'shared',
          skillEvolutionMinToolCalls: values.skillEvolutionMinToolCalls ?? 3,
          skillEvolutionCooldownMinutes: values.skillEvolutionCooldownMinutes ?? 30,
          skillEvolutionModel: values.skillEvolutionModel ?? '',
          safetyApprovalMode: values.safetyApprovalMode ?? 'manual',
          memoryProvider: values.memoryProvider ?? 'markdown',
          nightlyEnabled: values.nightlyEnabled ?? true,
          nightlyJudgeEnabled: values.nightlyJudgeEnabled ?? true,
          nightlyJudgeMinInteractions: values.nightlyJudgeMinInteractions ?? 20,
          nightlyExpression: values.nightlyExpression ?? true,
        })
      }
    >
      <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Required' }]}>
        <Input />
      </Form.Item>
      <Form.Item label="Description" name="description">
        <Input />
      </Form.Item>
      <PersonalityVoiceFields
        value={voice}
        agenticModel={modelChoice ?? personality.model}
        onChange={(next) => {
          setVoice(next);
          setDirty(true);
        }}
      />
      <Form.Item label="Model" extra={MODEL_FIELD_HELP}>
        <ModelDeclarationSelect
          ariaLabel="Model"
          value={modelChoice ?? personality.model}
          onChange={(next) => {
            setModelChoice(next);
            setDirty(true);
          }}
        />
      </Form.Item>
      <DecisionModelField
        value={decisions ?? decisionFieldValue(personality.decisions)}
        stored={personality.decisions}
        approvalMode={approvalMode}
        onChange={(next) => {
          setDecisions(next);
          setDirty(true);
        }}
      />
      <Form.Item label="Memory scope">
        <Typography.Text>per-personality</Typography.Text>
      </Form.Item>
      <Form.Item
        label={
          <span>
            Capabilities{' '}
            <Tooltip title="Tells the team what kind of work this agent does — e.g. coding, triage, release. Used when this agent collaborates with or delegates to other agents (mesh routing).">
              <InfoCircleOutlined style={{ color: 'var(--text-tertiary)' }} />
            </Tooltip>
          </span>
        }
        name="capabilities"
        extra="What kind of work this agent does, e.g. coding, triage, release. Helps other agents route work to it when working as a team."
      >
        <Select mode="tags" allowClear placeholder="add capability tags" tokenSeparators={[',']} />
      </Form.Item>
      <Form.Item label="Dreaming" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="dreaming" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Periodic background memory consolidation for this personality.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.dreaming !== cur.dreaming}>
        {({ getFieldValue }) =>
          getFieldValue('dreaming') ? (
            <>
              <Form.Item
                label="Idle minutes"
                name="dreamingIdleMinutes"
                extra="How long idle before a background dream turn."
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Max per day"
                name="dreamingMaxPerDay"
                extra="Cap on dream turns per rolling 24h."
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>
      <Form.Item
        label="Approval mode"
        name="evolutionApprovalMode"
        extra="Whether evolved voice updates apply automatically or wait for your approval."
      >
        <Select
          options={[
            { label: 'Automatic', value: 'auto' },
            { label: 'Requires approval', value: 'user' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Skill creation" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="skillEvolutionEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Auto-generate new skills from repeated task patterns.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item label="Skill evolution" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="skillEvolutionEvolveExisting" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Improve existing skills during eval-driven evolution. Does not affect the nightly create
            path.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item
        label="Promotion"
        name="skillEvolutionPromotion"
        extra="Review queues a new skill for your approval; Auto promotes it automatically."
      >
        <Segmented
          options={[
            { label: 'Review', value: 'review' },
            { label: 'Auto', value: 'auto' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Scope" name="skillEvolutionScope" extra="Where a promoted skill is saved.">
        <Segmented
          options={[
            { label: 'This personality', value: 'personality' },
            { label: 'Shared', value: 'shared' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Minimum tool calls"
        name="skillEvolutionMinToolCalls"
        extra="Tool calls in a turn before the evolver considers proposing a skill (1-20)."
      >
        <InputNumber min={1} max={20} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Cooldown (minutes)"
        name="skillEvolutionCooldownMinutes"
        extra="Minimum time between skill proposals to avoid noise."
      >
        <InputNumber min={0} step={5} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Model"
        name="skillEvolutionModel"
        extra="Model the skill evolver uses. Leave empty for the engine default."
      >
        <Input placeholder="engine default" />
      </Form.Item>
      <Form.Item
        label="Approval mode (safety)"
        name="safetyApprovalMode"
        extra="What the agent may do without asking — Manual asks every sensitive call; Smart asks only high-risk; Off runs all, trusted machines only."
      >
        <Select
          options={[
            { label: 'Manual', value: 'manual' },
            { label: 'Smart', value: 'smart' },
            { label: 'Off', value: 'off' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Memory backend"
        name="memoryProvider"
        extra="Where this personality stores memory. Markdown is human-editable; Vector uses embeddings for semantic recall."
      >
        <Select
          options={[
            { label: 'Markdown', value: 'markdown' },
            { label: 'Vector', value: 'vector' },
          ]}
        />
      </Form.Item>
      <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
        Nightly learning
      </Typography.Text>
      <Form.Item label="Nightly learning pass" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Master switch for the nightly governed-learning sweep.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item label="Personality Judge" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyJudgeEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Score recent responses against Core; needs at least N interactions.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.nightlyJudgeEnabled !== cur.nightlyJudgeEnabled}
      >
        {({ getFieldValue }) =>
          getFieldValue('nightlyJudgeEnabled') ? (
            <Form.Item
              label="Activation threshold"
              name="nightlyJudgeMinInteractions"
              extra="Minimum interactions before the Judge scores this personality."
            >
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          ) : null
        }
      </Form.Item>
      <Form.Item label="Expression evolution" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyExpression" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Sharpen voice toward what works during the nightly pass.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Provider API keys and Web API keys are account-wide — manage them in{' '}
          <Link to="/settings">Settings</Link>.
        </Typography.Text>
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths" name="fsReachRead" extra={FS_REACH_READ_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
        />
      </Form.Item>
      <Form.Item label="Write paths" name="fsReachWrite" extra={FS_REACH_WRITE_HELP}>
        <Select mode="tags" allowClear placeholder="e.g. /data/output" tokenSeparators={[',']} />
      </Form.Item>
      <Form.Item label="Working directories" name="fsReachWorkdir" extra={FS_REACH_WORKDIR_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_WORKDIR_PLACEHOLDER}
          tokenSeparators={[',']}
        />
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Network reach"
        description="Web tools that declare no hosts of their own — web_extract, the browser tools, the delegation tools — can reach exactly what is listed here, and nothing at all while it is empty. A tool that names its own hosts (web_search) is intersected with this list: it can be narrowed by it, never widened."
      />
      <Form.Item label="Allowed hosts" name="netAllow" extra={NET_ALLOW_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder="e.g. *, *.example.com"
          tokenSeparators={[',']}
        />
      </Form.Item>
      <Form.Item label="Blocked hosts" name="netDeny" extra={NET_DENY_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder="e.g. tracker.example.com"
          tokenSeparators={[',']}
        />
      </Form.Item>
      {/* `form.submit()` rather than a submit button: the shared bar carries no
          form semantics, and routing through submit keeps `onFinish`'s
          validation in the path. */}
      <TabSaveBar
        dirty={dirty}
        saving={mut.isPending}
        saveSucceeded={mut.isSuccess}
        onSave={() => form.submit()}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    </Form>
  );
}
