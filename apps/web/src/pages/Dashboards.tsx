import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, Skeleton, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

export function Dashboards() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => rpc.dashboards.list(),
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
        <Button type="primary" onClick={() => navigate('/dashboards/create')}>
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
    </div>
  );
}
