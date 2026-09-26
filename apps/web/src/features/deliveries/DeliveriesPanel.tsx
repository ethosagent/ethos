import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Space, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SectionHeading } from '../../pages/settings/components/section-heading';
import { deliveryAge } from '../../pages/settings/lib/deliveries';
import { rpc } from '../../rpc';

// Deliveries — the operator's window onto the gateway's two durability stores,
// on the Activity page's Deliveries tab (plan openclaw-2026.9.6-gaps U5). They
// used to live at the foot of Settings → Voice, where nobody looking for a lost
// reply would find them; the tables themselves moved here unchanged.
//
//   • Outbound — the delivery-obligation ledger (`deliveries.summary`): replies
//     still owed, redelivered, delivered or abandoned. Read-only by
//     construction — there is no RPC that re-sends, and this page must not be
//     able to re-send someone's message.
//   • Inbound — dead (plan reach-and-containment §2.6): messages the gateway
//     received and gave up on, plus interrupted ones. Replay hands the message
//     back to the gateway (its 60s replay tick re-runs the turn, safety filter
//     included); Discard closes it. Nothing is sent from here.

type DeliverySummary = Awaited<ReturnType<typeof rpc.deliveries.summary>>;
type DeliveryObligation = DeliverySummary['recent'][number];

const DELIVERY_STATUSES = ['pending', 'redelivering', 'delivered', 'abandoned'] as const;

/**
 * `redelivering` is the ledger's word for a claimed obligation mid-sweep. The
 * plan's state table calls what the user sees `redelivered`, because by the
 * time it is on screen the sweep is what happened to it.
 */
const DELIVERY_STATUS_LABELS: Record<(typeof DELIVERY_STATUSES)[number], string> = {
  pending: 'pending',
  redelivering: 'redelivered',
  delivered: 'delivered',
  abandoned: 'abandoned',
};

const DELIVERY_COLUMNS: ColumnsType<DeliveryObligation> = [
  {
    title: 'Platform',
    dataIndex: 'platform',
    render: (platform: string) => <span className="activity-mono">{platform}</span>,
  },
  {
    title: 'Kind',
    key: 'kind',
    render: (_: unknown, row: DeliveryObligation) => (
      <span className="activity-mono">
        {row.mediaFormat ? `${row.kind} · ${row.mediaFormat}` : row.kind}
      </span>
    ),
  },
  {
    title: 'Status',
    dataIndex: 'status',
    render: (status: DeliveryObligation['status']) => (
      <span className="activity-mono">{DELIVERY_STATUS_LABELS[status]}</span>
    ),
  },
  {
    title: 'Age',
    dataIndex: 'createdAt',
    render: (createdAt: number) => (
      <span className="activity-mono">{deliveryAge(createdAt, Date.now())}</span>
    ),
  },
  { title: 'Reply', dataIndex: 'content', ellipsis: true },
];

export function DeliveriesPanel() {
  return (
    <div>
      <SectionHeading id="outbound">outbound</SectionHeading>
      <DeliveryStatus />
      <SectionHeading id="inbound-dead">inbound — dead</SectionHeading>
      <InboundDeadLetters />
    </div>
  );
}

function DeliveryStatus() {
  const summaryQuery = useQuery({
    queryKey: ['deliveries', 'summary'],
    queryFn: () => rpc.deliveries.summary({ limit: 20 }),
  });

  if (summaryQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 60 }}>
        <Spin />
      </div>
    );
  }
  const data = summaryQuery.data;
  if (!data) {
    return (
      <Typography.Text type="secondary">
        Delivery ledger unreadable — {(summaryQuery.error as Error | null)?.message ?? 'no data'}.
      </Typography.Text>
    );
  }

  const total = DELIVERY_STATUSES.reduce((sum, s) => sum + data.stats[s], 0);
  if (total === 0 && data.recent.length === 0) {
    return (
      <Typography.Text type="secondary">
        No outbound obligations recorded. The ledger fills as the gateway sends channel replies —
        messages in this web chat are not obligations, so they never appear here.
      </Typography.Text>
    );
  }

  return (
    <>
      <div className="activity-stats">
        {DELIVERY_STATUSES.map((status) => (
          <div key={status} className="activity-stat">
            <span className="activity-mono">{DELIVERY_STATUS_LABELS[status]}</span>
            <span className="activity-count">{data.stats[status]}</span>
            <span className="activity-mono activity-split">voice {data.stats.voice[status]}</span>
          </div>
        ))}
      </div>
      {data.recent.length > 0 ? (
        <Table<DeliveryObligation>
          size="small"
          rowKey="id"
          pagination={false}
          columns={DELIVERY_COLUMNS}
          dataSource={data.recent}
          style={{ marginTop: 12 }}
        />
      ) : null}
    </>
  );
}

type DeadInbound = Awaited<ReturnType<typeof rpc.deliveries.listDeadInbound>>['rows'][number];

function InboundDeadLetters() {
  const queryClient = useQueryClient();
  const deadQuery = useQuery({
    queryKey: ['deliveries', 'deadInbound'],
    queryFn: () => rpc.deliveries.listDeadInbound({ limit: 50 }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['deliveries', 'deadInbound'] });
  const requeue = useMutation({
    mutationFn: (id: string) => rpc.deliveries.requeueInbound({ id }),
    onSettled: refresh,
  });
  const discard = useMutation({
    mutationFn: (id: string) => rpc.deliveries.discardInbound({ id }),
    onSettled: refresh,
  });

  if (deadQuery.isLoading) return null;
  const rows = deadQuery.data?.rows;
  if (!rows) {
    return (
      <Typography.Text type="secondary">
        Inbound spool unreadable — {(deadQuery.error as Error | null)?.message ?? 'no data'}.
      </Typography.Text>
    );
  }
  if (rows.length === 0) {
    return (
      <Typography.Text type="secondary">
        No dead inbound messages. A message lands here only after its turn failed on every attempt,
        it was too old to answer when the gateway restarted, or it was interrupted after an action
        had started.
      </Typography.Text>
    );
  }
  const busy = requeue.isPending || discard.isPending;
  const columns: ColumnsType<DeadInbound> = [
    {
      title: 'Platform',
      key: 'where',
      render: (_: unknown, row: DeadInbound) => (
        <span className="activity-mono">
          {row.platform}:{row.chatId}
        </span>
      ),
    },
    {
      title: 'State',
      dataIndex: 'status',
      render: (status: DeadInbound['status']) => (
        <span className="activity-mono">
          {status === 'interrupted' ? 'interrupted — awaiting retry' : 'dead'}
        </span>
      ),
    },
    {
      title: 'Attempts',
      dataIndex: 'attempts',
      render: (n: number) => <span className="activity-mono">{n}</span>,
    },
    {
      title: 'Reason',
      dataIndex: 'lastError',
      ellipsis: true,
      render: (reason: string | null) => <span className="activity-mono">{reason ?? '—'}</span>,
    },
    {
      title: 'Age',
      dataIndex: 'receivedAt',
      render: (receivedAt: number) => (
        <span className="activity-mono">{deliveryAge(receivedAt, Date.now())}</span>
      ),
    },
    { title: 'Message', dataIndex: 'text', ellipsis: true },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, row: DeadInbound) => (
        <Space size="small">
          <Button size="small" disabled={busy} onClick={() => requeue.mutate(row.id)}>
            Replay
          </Button>
          <Button size="small" disabled={busy} onClick={() => discard.mutate(row.id)}>
            Discard
          </Button>
        </Space>
      ),
    },
  ];
  return (
    <Table<DeadInbound>
      size="small"
      rowKey="id"
      pagination={false}
      columns={columns}
      dataSource={rows}
      style={{ marginTop: 12 }}
    />
  );
}
