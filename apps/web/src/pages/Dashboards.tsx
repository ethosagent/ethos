import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, Input, Modal, Select, Skeleton, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

export function Dashboards() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => rpc.dashboards.list(),
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');

  const { data: persData } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });
  const [selectedPersonality, setSelectedPersonality] = useState<string>('');

  const createMut = useMutation({
    mutationFn: () =>
      rpc.dashboards.create({
        title,
        personalityId: selectedPersonality,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      setCreateOpen(false);
      setTitle('');
      navigate(`/dashboards/${result.dashboard.id}`);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.dashboards.delete({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboards'] }),
  });

  if (isLoading) return <Skeleton active />;

  const dashboards = data?.dashboards ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Dashboards
        </Typography.Title>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Create Dashboard
        </Button>
      </div>

      {dashboards.length === 0 ? (
        <Empty description="No dashboards yet" />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {dashboards.map((d) => (
            <Card
              key={d.id}
              hoverable
              onClick={() => navigate(`/dashboards/${d.id}`)}
              actions={[
                <Button
                  key="del"
                  type="text"
                  danger
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteMut.mutate(d.id);
                  }}
                >
                  Delete
                </Button>,
              ]}
            >
              <Card.Meta
                title={d.title}
                description={
                  d.description || `Created ${new Date(d.createdAt).toLocaleDateString()}`
                }
              />
            </Card>
          ))}
        </div>
      )}

      <Modal
        title="Create Dashboard"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createMut.mutate()}
        okText="Create"
        okButtonProps={{
          disabled: !title || !selectedPersonality,
          loading: createMut.isPending,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            placeholder="Dashboard title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Select
            placeholder="Select personality"
            value={selectedPersonality || undefined}
            onChange={setSelectedPersonality}
            options={(persData?.items ?? []).map((p: { id: string; name: string }) => ({
              label: p.name,
              value: p.id,
            }))}
          />
        </div>
      </Modal>
    </div>
  );
}
