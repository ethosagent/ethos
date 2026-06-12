import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, List, Spin, Typography } from 'antd';
import { rpc } from '../rpc';

/**
 * Panel listing pending skill proposals with Approve / Reject buttons.
 * Fetches from the existing `rpc.evolver.pendingList` endpoint and
 * dispatches to `rpc.evolver.pendingApprove` / `rpc.evolver.pendingReject`.
 */
export function SkillProposals() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'pendingList'],
    queryFn: () => rpc.evolver.pendingList({}),
    refetchInterval: 30_000,
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingApprove({ id }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pendingList'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: `Approved ${id}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingReject({ id }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pendingList'] });
      notification.success({ message: `Rejected ${id}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load proposals: {(error as Error).message}
      </Typography.Text>
    );
  }

  const pending = data?.pending ?? [];

  if (pending.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No pending skill proposals. Run `ethos evolve run` or wait for the auto-trigger."
      />
    );
  }

  return (
    <List
      dataSource={pending}
      renderItem={(item) => (
        <List.Item
          key={item.id}
          actions={[
            <Button
              key="approve"
              type="primary"
              size="small"
              loading={approveMut.isPending && approveMut.variables === item.id}
              onClick={() => approveMut.mutate(item.id)}
            >
              Approve
            </Button>,
            <Button
              key="reject"
              size="small"
              danger
              loading={rejectMut.isPending && rejectMut.variables === item.id}
              onClick={() => rejectMut.mutate(item.id)}
            >
              Reject
            </Button>,
          ]}
        >
          <List.Item.Meta
            title={item.name || item.id}
            description={
              <span style={{ fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                {item.description ?? item.id}
                {item.proposedAt ? ` — ${new Date(item.proposedAt).toLocaleString()}` : ''}
              </span>
            }
          />
        </List.Item>
      )}
    />
  );
}
