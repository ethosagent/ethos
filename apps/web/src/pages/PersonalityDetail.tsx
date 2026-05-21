import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Result, Spin, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { rpc } from '../rpc';
import { EditModal } from './Personalities';

export function PersonalityDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
    enabled: id.length > 0,
  });

  if (!id) {
    return <Result status="404" title="Personality not found" />;
  }
  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error || !data) {
    return <Result status="error" title="Failed to load personality" />;
  }

  const { personality } = data;
  const model = personality.model;
  const modelDisplay =
    typeof model === 'string'
      ? model
      : model
        ? (model.default ?? model.trivial ?? model.deep ?? null)
        : null;

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <Button
        type="link"
        onClick={() => navigate('/personalities')}
        style={{ paddingLeft: 0, marginBottom: 16 }}
      >
        &larr; Personalities
      </Button>

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <PersonalityMark personalityId={personality.id} size={48} />
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {personality.name}
            </Typography.Title>
            <Typography.Text
              type="secondary"
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
            >
              {personality.id}
            </Typography.Text>
          </div>
        </div>

        {personality.description ? (
          <Typography.Paragraph type="secondary">{personality.description}</Typography.Paragraph>
        ) : null}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 24px',
            fontSize: 14,
          }}
        >
          {modelDisplay ? (
            <>
              <Typography.Text type="secondary">Model</Typography.Text>
              <Typography.Text code>{modelDisplay}</Typography.Text>
            </>
          ) : null}
          {personality.memoryScope ? (
            <>
              <Typography.Text type="secondary">Memory scope</Typography.Text>
              <Typography.Text>{personality.memoryScope}</Typography.Text>
            </>
          ) : null}
          {personality.fs_reach !== undefined && personality.fs_reach !== null ? (
            <>
              <Typography.Text type="secondary">FS reach</Typography.Text>
              <Typography.Text>
                {[
                  ...(personality.fs_reach.read ?? []).map((p: string) => `R ${p}`),
                  ...(personality.fs_reach.write ?? []).map((p: string) => `W ${p}`),
                ].join(', ') || 'none'}
              </Typography.Text>
            </>
          ) : null}
        </div>

        <div style={{ marginTop: 16 }}>
          <Button onClick={() => setEditModalOpen(true)}>Edit personality</Button>
        </div>
      </div>

      {editModalOpen ? (
        <EditModal
          id={id}
          onClose={() => {
            setEditModalOpen(false);
            qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
          }}
        />
      ) : null}
    </div>
  );
}
