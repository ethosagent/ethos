import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Form, Input, Modal, Tabs } from 'antd';
import { useState } from 'react';
import {
  PersonalityVoiceFields,
  voiceCreateInput,
} from '../../components/personality/PersonalityVoiceFields';
import { wizardFsReach } from '../../lib/personalityFsReach';
import { rpc } from '../../rpc';
import { WizardPluginsTab } from './PluginsPanels';
import { SkillsPicker } from './SkillsPanels';
import type { WizardState } from './shared';
import { BLANK_VOICE } from './shared';
import { ToolsetPicker } from './ToolsetPickers';
import { SkillLearningStep, SoulMdStep, WizardConfigTab } from './WizardSteps';

// ---------------------------------------------------------------------------
// Create wizard (4 steps)
// ---------------------------------------------------------------------------

const SOUL_TEMPLATE = `# About me\n\nI am a {role}. I {what I do}. I {how I work}.\n\n## How I respond\n\n- {tone / shape}\n- {tone / shape}\n- {tone / shape}\n`;

export function CreateWizard({
  existingIds,
  onClose,
}: {
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [state, setState] = useState<WizardState>({
    id: '',
    name: '',
    description: '',
    model: '',
    capabilities: [],
    fsReachRead: [],
    fsReachWrite: [],
    fsReachWorkdir: [],
    toolset: ['memory_read', 'memory_write', 'session_search', 'cron'],
    soulMd: SOUL_TEMPLATE,
    skills: [],
    plugins: [],
    skillEvolutionEnabled: true,
    skillEvolutionMinToolCalls: 3,
    skillEvolutionCooldownMinutes: 30,
    evolutionApprovalMode: 'user',
    voice: BLANK_VOICE,
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.personalities.create({
        id: state.id,
        name: state.name,
        ...(state.description ? { description: state.description } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.capabilities.length > 0 ? { capabilities: state.capabilities } : {}),
        ...wizardFsReach(state),
        ...(state.plugins.length > 0 ? { plugins: state.plugins } : {}),
        toolset: state.toolset,
        soulMd: state.soulMd,
        skill_evolution: {
          enabled: state.skillEvolutionEnabled,
          min_tool_calls: state.skillEvolutionMinToolCalls,
          cooldown_minutes: state.skillEvolutionCooldownMinutes,
        },
        evolution_approval_mode: state.evolutionApprovalMode,
        // Omitted entirely when none is set, so a personality created without
        // touching these carries no `voice` block at all.
        ...voiceCreateInput(state.voice),
      }),
    onSuccess: async () => {
      if (state.skills.length > 0) {
        try {
          await rpc.personalities.skillsImportGlobal({
            personalityId: state.id,
            skillIds: state.skills,
          });
        } catch {
          notification.warning({
            message: `Created ${state.name}, but skill attachment failed`,
            description: 'Open the personality editor to attach skills manually.',
            placement: 'topRight',
          });
          qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
          qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
          onClose();
          return;
        }
      }
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Created ${state.name}`, placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(state.id);
  const nameValid = state.name.trim().length > 0;
  const idCollision = existingIds.has(state.id);
  const canCreate = idValid && nameValid && !idCollision && state.soulMd.length > 0;

  return (
    <Modal
      open
      title="New personality"
      onCancel={onClose}
      width={720}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!canCreate}
            loading={createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            Create
          </Button>
        </div>
      }
    >
      <Tabs
        defaultActiveKey="basics"
        items={[
          {
            key: 'basics',
            label: 'Basics',
            children: <IdentityStep state={state} setState={setState} idCollision={idCollision} />,
          },
          {
            key: 'soul',
            label: 'Soul',
            children: <SoulMdStep state={state} setState={setState} />,
          },
          {
            key: 'config',
            label: 'Config',
            children: <WizardConfigTab state={state} setState={setState} />,
          },
          {
            key: 'toolset',
            label: 'Toolset',
            children: <ToolsetStep state={state} setState={setState} />,
          },
          {
            key: 'skill-learning',
            label: 'Skill Learning',
            children: <SkillLearningStep state={state} setState={setState} />,
          },
          {
            key: 'skills',
            label: 'Skills',
            children: <WizardSkillsStep state={state} setState={setState} />,
          },
          {
            key: 'plugins',
            label: 'Plugins',
            children: (
              <WizardPluginsTab
                selected={state.plugins}
                onChange={(next) => setState((s) => ({ ...s, plugins: next }))}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}

function IdentityStep({
  state,
  setState,
  idCollision,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  idCollision: boolean;
}) {
  return (
    <Form layout="vertical">
      <Form.Item label="Name" required help="Display name. The id below is derived from this.">
        <Input
          autoFocus
          value={state.name}
          placeholder="e.g. Strategist"
          onChange={(e) => {
            const name = e.target.value;
            const derivedId = name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9_-]/g, '');
            setState((s) => ({ ...s, name, id: s.id === slugify(s.name) ? derivedId : s.id }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="ID"
        required
        validateStatus={idCollision ? 'error' : undefined}
        help={
          idCollision
            ? 'Already taken by an existing personality.'
            : 'Lowercase, dash/underscore-separated. Becomes the directory name.'
        }
      >
        <Input
          value={state.id}
          placeholder="strategist"
          onChange={(e) => setState((s) => ({ ...s, id: e.target.value.toLowerCase() }))}
        />
      </Form.Item>
      <Form.Item label="Description" help="One-line summary, optional.">
        <Input
          value={state.description}
          placeholder="What this personality is good at."
          onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
        />
      </Form.Item>
      <PersonalityVoiceFields
        value={state.voice}
        agenticModel={state.model}
        onChange={(voice) => setState((s) => ({ ...s, voice }))}
      />
    </Form>
  );
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function ToolsetStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const toggle = (name: string) => {
    setState((s) => {
      const has = s.toolset.includes(name);
      return { ...s, toolset: has ? s.toolset.filter((t) => t !== name) : [...s.toolset, name] };
    });
  };

  return <ToolsetPicker selected={state.toolset} onToggle={toggle} />;
}

function WizardSkillsStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const toggle = (skillId: string) => {
    setState((prev) => {
      const next = new Set(prev.skills);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return { ...prev, skills: [...next] };
    });
  };

  return <SkillsPicker selected={state.skills} onToggle={toggle} />;
}
