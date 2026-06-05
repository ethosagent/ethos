import { personalityAccent } from '@ethosagent/design-tokens';

export type NodeStatus = 'healthy' | 'reconnecting' | 'error';

export interface MeshNode {
  id: string;
  name: string;
  type: 'gateway' | 'agent';
  status: NodeStatus;
  personality?: string;
}

interface MeshTopologyProps {
  nodes: MeshNode[];
}

const STATUS_FILL: Record<NodeStatus, string> = {
  healthy: 'var(--green, #4ADE80)',
  reconnecting: 'var(--amber, #F59E0B)',
  error: 'var(--red, #F87171)',
};

const VIEW_W = 480;
const VIEW_H = 300;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const GATEWAY_R = 40;
const AGENT_R = 24;
const ORBIT = Math.min(VIEW_W, VIEW_H) * 0.36;

function nodePositions(nodes: MeshNode[]): { node: MeshNode; x: number; y: number }[] {
  const gateway = nodes.find((n) => n.type === 'gateway');
  const agents = nodes.filter((n) => n.type === 'agent');

  const result: { node: MeshNode; x: number; y: number }[] = [];

  if (gateway) {
    result.push({ node: gateway, x: CX, y: CY });
  }

  for (let i = 0; i < agents.length; i++) {
    const angle = -Math.PI / 2 + (Math.PI / Math.max(agents.length - 1, 1)) * i;
    const spread = agents.length === 1 ? 0 : angle;
    const x = CX + ORBIT * Math.cos(agents.length === 1 ? -Math.PI / 2 : spread);
    const y = CY + ORBIT * Math.sin(agents.length === 1 ? -Math.PI / 2 : spread);
    result.push({ node: agents[i], x, y });
  }

  return result;
}

export function MeshTopology({ nodes }: MeshTopologyProps) {
  const positioned = nodePositions(nodes);
  const gatewayPos = positioned.find((p) => p.node.type === 'gateway');
  const agentPositions = positioned.filter((p) => p.node.type === 'agent');

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md, 8px)',
        padding: 24,
        minHeight: 260,
      }}
    >
      <svg
        role="img"
        aria-label="Mesh topology"
        width="100%"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        style={{ display: 'block' }}
      >
        <title>Mesh topology</title>
        {/* Edges: gateway to each agent */}
        {gatewayPos &&
          agentPositions.map((ap) => (
            <line
              key={`edge-${ap.node.id}`}
              x1={gatewayPos.x}
              y1={gatewayPos.y}
              x2={ap.x}
              y2={ap.y}
              stroke="var(--border-strong, #3A3A3A)"
              strokeWidth={1}
            />
          ))}

        {/* Nodes */}
        {positioned.map((p) => {
          const isGateway = p.node.type === 'gateway';
          const r = isGateway ? GATEWAY_R : AGENT_R;
          const strokeColor = isGateway
            ? 'var(--blue, #4A9EFF)'
            : personalityAccent(p.node.personality ?? 'operator');

          return (
            <g key={p.node.id}>
              {/* Node circle */}
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill="var(--bg-base, #0F0F0F)"
                stroke={strokeColor}
                strokeWidth={2}
              />
              {/* Health dot */}
              <circle cx={p.x} cy={p.y} r={3} fill={STATUS_FILL[p.node.status]} />
              {/* Label below */}
              <text
                x={p.x}
                y={p.y + r + 14}
                textAnchor="middle"
                fill="var(--text-secondary, #9A9A98)"
                fontFamily="'JetBrains Mono', ui-monospace, monospace"
                fontSize={11}
              >
                {p.node.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
