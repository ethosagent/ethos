import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, message, Select, Tabs } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../../rpc';

interface Props {
  open: boolean;
  onClose: () => void;
  userMessage?: string;
  sessionId?: string;
}

export function SaveToDashboardModal({ open, onClose, userMessage, sessionId }: Props) {
  const [tab, setTab] = useState<'user' | 'summary'>('user');
  const [prompt, setPrompt] = useState(userMessage ?? '');
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [cronSchedule, setCronSchedule] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();

  const { data: dashboards } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => rpc.dashboards.list(),
    enabled: open,
  });

  // summarizePrompt is not yet in the contract — wire this when the RPC is added
  const summaryAvailable = false;
  const summary: string | undefined = undefined;
  const summaryLoading = false;

  const saveMut = useMutation({
    mutationFn: () =>
      rpc.dashboards.addPanel({
        dashboardId: dashboardId,
        newDashboardTitle: dashboardId ? undefined : newTitle,
        personalityId: 'default',
        panel: {
          queryType: 'prompt',
          blockType: 'html',
          content: '',
          prompt: tab === 'summary' ? (summary ?? prompt) : prompt,
          cronSchedule: cronSchedule || undefined,
        },
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      const targetId = dashboardId ?? result.panel.dashboardId;
      onClose();
      messageApi.success('Saved to dashboard');
      if (targetId) navigate(`/dashboards/${targetId}`);
    },
  });

  const canSave =
    (dashboardId || newTitle.trim()) && (prompt.trim() || (tab === 'summary' && summary));

  return (
    <>
      {contextHolder}
      <Modal
        title="Save to Dashboard"
        open={open}
        onCancel={onClose}
        footer={[
          <Button key="cancel" onClick={onClose}>
            Cancel
          </Button>,
          <Button
            key="save"
            type="primary"
            disabled={!canSave}
            loading={saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            Save & Preview
          </Button>,
        ]}
        width={600}
      >
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as 'user' | 'summary')}
          items={[
            {
              key: 'user',
              label: 'User Message',
              children: (
                <Input.TextArea
                  rows={6}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Enter the prompt to re-run for this widget..."
                />
              ),
            },
            {
              key: 'summary',
              label: 'Conversation Summary',
              disabled: !sessionId,
              children: summaryLoading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>
                  Generating summary...
                </div>
              ) : summaryAvailable ? (
                <Input.TextArea
                  rows={6}
                  value={summary ?? ''}
                  placeholder="Conversation summary will appear here..."
                  readOnly
                />
              ) : (
                <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>
                  Conversation summary not available yet.
                </div>
              ),
            },
          ]}
        />

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Select
            placeholder="Select dashboard or create new"
            value={dashboardId}
            onChange={(v) => {
              setDashboardId(v);
              setNewTitle('');
            }}
            allowClear
            options={(dashboards?.dashboards ?? []).map((d) => ({ label: d.title, value: d.id }))}
            style={{ width: '100%' }}
          />
          {!dashboardId && (
            <Input
              placeholder="New dashboard name"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          )}
          <Input
            placeholder="Cron schedule (optional, e.g. 0 9 * * 1)"
            value={cronSchedule}
            onChange={(e) => setCronSchedule(e.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}
