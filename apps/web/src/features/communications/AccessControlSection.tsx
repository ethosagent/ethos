// The per-platform "Access Control" card of the Communications page (owner id +
// allowlist), split out of pages/Communications.tsx.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  Input,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { rpc } from '../../rpc';

const PLATFORM_HINTS: Record<string, string> = {
  telegram: 'Send /start to @userinfobot. The number shown is your user ID.',
  slack: 'Open your Slack profile → click the … menu → "Copy member ID".',
  discord: 'Enable Developer Mode → right-click your name → "Copy User ID".',
  email: "Use the sender's full email address (globs supported: *@example.com).",
  whatsapp: 'Your WhatsApp phone number in E.164 format (e.g., +14155551234).',
};

export function AccessControlSection({ platform }: { platform: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [enabled, setEnabled] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [saved, setSaved] = useState(false);

  const filterQuery = useQuery({
    queryKey: ['platforms', 'channelFilter', platform],
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });

  useEffect(() => {
    if (filterQuery.data) {
      setEnabled(filterQuery.data.filter.enabled);
      setOwnerUserId(filterQuery.data.filter.ownerUserId);
      setAllowlist(filterQuery.data.filter.allowlist);
    }
  }, [filterQuery.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      rpc.platforms.setChannelFilter({
        platform,
        filter: { enabled, ownerUserId, allowlist },
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['platforms', 'channelFilter', platform] });
      setEnabled(data.filter.enabled);
      setOwnerUserId(data.filter.ownerUserId);
      setAllowlist(data.filter.allowlist);
      setSaved(true);
      notification.success({ message: 'Access control saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const hint = PLATFORM_HINTS[platform] ?? '';

  const addId = () => {
    const trimmed = newId.trim();
    if (trimmed && !allowlist.includes(trimmed)) {
      setAllowlist([...allowlist, trimmed]);
    }
    setNewId('');
  };

  return (
    <>
      <Divider style={{ margin: '24px 0 16px' }} />
      <Card size="small" title="Access Control" style={{ maxWidth: 720 }}>
        {filterQuery.isLoading ? (
          <Spin />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Switch checked={enabled} onChange={setEnabled} />
              <Typography.Text>Restrict to specific users</Typography.Text>
            </div>

            {enabled && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
                    Owner ID
                  </Typography.Text>
                  <Input
                    value={ownerUserId}
                    onChange={(e) => setOwnerUserId(e.target.value)}
                    placeholder="Owner user ID"
                    style={{ maxWidth: 400 }}
                  />
                  {hint && (
                    <Typography.Text
                      type="secondary"
                      style={{ display: 'block', marginTop: 4, fontSize: 12 }}
                    >
                      {hint}
                    </Typography.Text>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                    Additional users
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {allowlist.map((id) => (
                      <Tag
                        key={id}
                        closable
                        onClose={() => setAllowlist(allowlist.filter((x) => x !== id))}
                      >
                        {id}
                      </Tag>
                    ))}
                  </div>
                  <Space.Compact>
                    <Input
                      value={newId}
                      onChange={(e) => setNewId(e.target.value)}
                      onPressEnter={addId}
                      placeholder="Add user ID"
                      style={{ maxWidth: 300 }}
                    />
                    <Button onClick={addId}>Add</Button>
                  </Space.Compact>
                </div>
              </>
            )}

            <Button
              type="primary"
              style={{ marginTop: 16 }}
              loading={saveMut.isPending}
              onClick={() => saveMut.mutate()}
            >
              Save access control
            </Button>

            {saved && (
              <Alert
                type="info"
                showIcon
                message="Restart the gateway to apply. Access control is read once at startup — unlike adding or removing a bot, it does not reload live. Until you restart, a new bot on a platform whose access control is also new is refused rather than run without it."
                style={{ marginTop: 16 }}
              />
            )}
          </>
        )}
      </Card>
    </>
  );
}
