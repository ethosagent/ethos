import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, message, Popover } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

interface Props {
  blockType: 'html' | 'image' | 'pdf';
  content: string;
  metadata?: Record<string, unknown>;
}

export function SaveToDashboardButton({ blockType, content, metadata }: Props) {
  const [open, setOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => rpc.dashboards.list(),
    enabled: open,
  });

  const saveMut = useMutation({
    mutationFn: (opts: { dashboardId: string | null; newDashboardTitle?: string }) =>
      rpc.dashboards.addPanel({
        dashboardId: opts.dashboardId,
        newDashboardTitle: opts.newDashboardTitle,
        personalityId: 'default',
        panel: {
          queryType: 'static',
          blockType,
          content,
          metadata,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      setOpen(false);
      messageApi.success('Saved to dashboard');
    },
  });

  const popoverContent = (
    <div style={{ width: 220 }}>
      <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 12 }}>Save to dashboard</div>
      {(data?.dashboards ?? []).map((d) => (
        <button
          key={d.id}
          type="button"
          style={{
            display: 'block',
            width: '100%',
            padding: '6px 8px',
            cursor: 'pointer',
            borderRadius: 4,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            fontSize: 'inherit',
          }}
          onClick={() => saveMut.mutate({ dashboardId: d.id })}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#222';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          {d.title}
        </button>
      ))}
      <div style={{ borderTop: '1px solid #333', marginTop: 8, paddingTop: 8 }}>
        <Input
          size="small"
          placeholder="New dashboard name"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onPressEnter={() => {
            if (newTitle.trim()) {
              saveMut.mutate({ dashboardId: null, newDashboardTitle: newTitle.trim() });
            }
          }}
        />
        <Button
          size="small"
          type="primary"
          style={{ marginTop: 4, width: '100%' }}
          disabled={!newTitle.trim()}
          loading={saveMut.isPending}
          onClick={() => saveMut.mutate({ dashboardId: null, newDashboardTitle: newTitle.trim() })}
        >
          Create & Save
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {contextHolder}
      <Popover
        content={popoverContent}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
      >
        <button
          type="button"
          className="dashboard-save-btn"
          title="Save to dashboard"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            borderRadius: 4,
            color: '#fff',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: 14,
            opacity: 0,
            transition: 'opacity 0.15s',
            zIndex: 10,
          }}
        >
          Save
        </button>
      </Popover>
    </>
  );
}
