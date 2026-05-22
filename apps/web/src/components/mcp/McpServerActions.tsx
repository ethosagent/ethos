import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, Space, Tooltip, message } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

interface Props {
  serverName: string;
  transport: string;
  authStatus?: string | null;
}

export function McpServerActions({ serverName, transport, authStatus }: Props) {
  const qc = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [tokenOpen, setTokenOpen] = useState(false);
  const [newToken, setNewToken] = useState('');

  const refreshMut = useMutation({
    mutationFn: () => rpc.mcp.refreshToken({ serverName }),
    onSuccess: (result) => {
      if (result.ok) {
        message.success('Token refreshed');
        qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
      } else {
        message.error(result.error ?? 'Refresh failed');
      }
    },
  });

  const renameMut = useMutation({
    mutationFn: (name: string) => rpc.mcp.rename({ oldName: serverName, newName: name }),
    onSuccess: () => {
      message.success('Server renamed');
      setRenameOpen(false);
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });

  const tokenMut = useMutation({
    mutationFn: (token: string) => rpc.mcp.updateToken({ serverName, token }),
    onSuccess: () => {
      message.success('Token updated');
      setTokenOpen(false);
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
    },
  });

  return (
    <>
      <Space size="small">
        {/* Issue 3: Refresh OAuth token */}
        {authStatus === 'expired' || authStatus === 'authorized' ? (
          <Tooltip title="Refresh OAuth token">
            <Button
              size="small"
              onClick={() => refreshMut.mutate()}
              loading={refreshMut.isPending}
            >
              Refresh
            </Button>
          </Tooltip>
        ) : null}

        {/* Issue 5: Rename */}
        <Tooltip title="Rename server">
          <Button
            size="small"
            onClick={() => {
              setNewName(serverName);
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
        </Tooltip>

        {/* Issue 6: Update bearer token — only for non-OAuth, non-stdio servers */}
        {transport !== 'stdio' && (!authStatus || authStatus === 'none') ? (
          <Tooltip title="Update bearer token">
            <Button
              size="small"
              onClick={() => {
                setNewToken('');
                setTokenOpen(true);
              }}
            >
              Token
            </Button>
          </Tooltip>
        ) : null}
      </Space>

      {/* Rename modal */}
      <Modal
        open={renameOpen}
        title="Rename Server"
        onCancel={() => setRenameOpen(false)}
        onOk={() => renameMut.mutate(newName)}
        confirmLoading={renameMut.isPending}
        okButtonProps={{ disabled: !newName.trim() || newName === serverName }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New server name"
          maxLength={64}
        />
      </Modal>

      {/* Update token modal */}
      <Modal
        open={tokenOpen}
        title="Update Bearer Token"
        onCancel={() => setTokenOpen(false)}
        onOk={() => tokenMut.mutate(newToken)}
        confirmLoading={tokenMut.isPending}
        okButtonProps={{ disabled: !newToken.trim() }}
      >
        <Input.Password
          value={newToken}
          onChange={(e) => setNewToken(e.target.value)}
          placeholder="Paste new bearer token"
        />
      </Modal>
    </>
  );
}
