import { InfoCircleOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, Modal, Select, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { ModelDeclarationSelect } from '../../components/personality/ModelDeclarationSelect';
import { rpc } from '../../rpc';
import type { WizardState } from './shared';
import {
  FS_REACH_READ_HELP,
  FS_REACH_READ_PLACEHOLDER,
  FS_REACH_WORKDIR_HELP,
  FS_REACH_WORKDIR_PLACEHOLDER,
  FS_REACH_WRITE_HELP,
  MODEL_FIELD_HELP,
} from './shared';

export function SkillLearningStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        When enabled, the agent automatically proposes new skills based on repeated tool-call
        patterns. Proposed skills land in a pending queue for review.
      </Typography.Paragraph>
      <Form.Item>
        <Checkbox
          checked={state.skillEvolutionEnabled}
          onChange={(e) => setState((s) => ({ ...s, skillEvolutionEnabled: e.target.checked }))}
        >
          Enable automatic skill learning
        </Checkbox>
      </Form.Item>
      <Form.Item
        label="Minimum tool calls"
        help="Number of tool calls in a turn before the evolver considers proposing a skill (1-20)."
      >
        <Input
          type="number"
          min={1}
          max={20}
          value={state.skillEvolutionMinToolCalls}
          disabled={!state.skillEvolutionEnabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 1 && v <= 20) setState((s) => ({ ...s, skillEvolutionMinToolCalls: v }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="Cooldown (minutes)"
        help="Minimum time between skill proposals to avoid noise."
      >
        <Input
          type="number"
          min={0}
          step={5}
          value={state.skillEvolutionCooldownMinutes}
          disabled={!state.skillEvolutionEnabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 0) setState((s) => ({ ...s, skillEvolutionCooldownMinutes: v }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="Approval mode"
        help="Whether evolved voice updates apply automatically or wait for your approval."
      >
        <Select
          value={state.evolutionApprovalMode}
          onChange={(v) => setState((s) => ({ ...s, evolutionApprovalMode: v }))}
          options={[
            { label: 'Automatic', value: 'auto' },
            { label: 'Requires approval', value: 'user' },
          ]}
        />
      </Form.Item>
    </Form>
  );
}

export function SoulMdStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [core, setCore] = useState('');
  const [expression, setExpression] = useState('');
  const [rationale, setRationale] = useState('');

  const splitMut = useMutation({
    mutationFn: () => rpc.personalities.proposeSoulSplit({ soulMd: state.soulMd }),
    onSuccess: (data) => {
      setCore(data.core);
      setExpression(data.expression);
      setRationale(data.rationale);
      setReviewOpen(true);
    },
  });

  const notConfigured = splitMut.isError && errorCode(splitMut.error) === 'NOT_CONFIGURED';

  function applySplit() {
    const sectioned = `# Core\n${core.trim()}\n\n# Expression\n${expression.trim()}\n`;
    setState((s) => ({ ...s, soulMd: sectioned }));
    setReviewOpen(false);
    splitMut.reset();
  }

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        First-person identity. The agent reads this on every turn — keep it short and concrete.
        Avoid "🚀 ready to help!" boilerplate.
      </Typography.Paragraph>
      <Form.Item required>
        <Input.TextArea
          value={state.soulMd}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setState((s) => ({ ...s, soulMd: e.target.value }))}
        />
      </Form.Item>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          disabled={state.soulMd.trim().length === 0}
          loading={splitMut.isPending}
          onClick={() => splitMut.mutate()}
        >
          Refine soul
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Proposes a Core / Expression split for you to review before it's applied.
        </Typography.Text>
      </div>
      {notConfigured ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="Soul refinement needs an LLM configured on the server"
        />
      ) : splitMut.isError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message="Couldn't propose a split"
          description={(splitMut.error as Error).message}
        />
      ) : null}

      <Modal
        open={reviewOpen}
        title="Review Core / Expression split"
        onCancel={() => setReviewOpen(false)}
        width={680}
        destroyOnClose
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button type="primary" onClick={applySplit}>
              Apply split
            </Button>
          </div>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {rationale}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Core is your immutable identity; Expression is the voice that can evolve later. Adjust the
          partition below before applying.
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="Core">
            <Input.TextArea
              value={core}
              autoSize={{ minRows: 6, maxRows: 16 }}
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
              onChange={(e) => setCore(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="Expression">
            <Input.TextArea
              value={expression}
              autoSize={{ minRows: 6, maxRows: 16 }}
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
              onChange={(e) => setExpression(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Form>
  );
}

/** Reads the structured `code` off an oRPC client error, if present. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function WizardConfigTab({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        Optional. Leave blank to use the global default from Settings.
      </Typography.Paragraph>
      <Form.Item label="Model" extra={MODEL_FIELD_HELP}>
        <ModelDeclarationSelect
          ariaLabel="Model"
          value={state.model}
          onChange={(model) => setState((s) => ({ ...s, model }))}
        />
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
        extra="What kind of work this agent does, e.g. coding, triage, release. Helps other agents route work to it when working as a team."
      >
        <Select
          mode="tags"
          allowClear
          placeholder="add capability tags"
          tokenSeparators={[',']}
          value={state.capabilities}
          onChange={(val) => setState((s) => ({ ...s, capabilities: val }))}
        />
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths" extra={FS_REACH_READ_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
          value={state.fsReachRead}
          onChange={(val) => setState((s) => ({ ...s, fsReachRead: val }))}
        />
      </Form.Item>
      <Form.Item label="Write paths" extra={FS_REACH_WRITE_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder="e.g. /data/output"
          tokenSeparators={[',']}
          value={state.fsReachWrite}
          onChange={(val) => setState((s) => ({ ...s, fsReachWrite: val }))}
        />
      </Form.Item>
      <Form.Item label="Working directories" extra={FS_REACH_WORKDIR_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_WORKDIR_PLACEHOLDER}
          tokenSeparators={[',']}
          value={state.fsReachWorkdir}
          onChange={(val) => setState((s) => ({ ...s, fsReachWorkdir: val }))}
        />
      </Form.Item>
    </Form>
  );
}
