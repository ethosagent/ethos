import { Button, ConfigProvider, Result, Space, Typography } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { useChat } from '../hooks/useChat';
import { personalityTheme } from '../lib/theme';

const ARCHITECT_ID = 'team-architect';

/**
 * Wizard page for AI-assisted team creation. Two phases:
 *
 *   Phase 1 — Chat with the team-architect agent. It asks discovery
 *             questions and eventually calls `scaffold_team`.
 *   Phase 2 — Success panel with navigation to the teams page.
 */
export function TeamCreate() {
  const navigate = useNavigate();
  const { state, sendMessage } = useChat({ personalityId: ARCHITECT_ID });

  // Detect scaffold completion. The architect's final message contains the
  // string "scaffolded successfully" after calling the tool.
  const scaffoldResult = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg?.role !== 'assistant') continue;
      const text = msg.blocks
        .filter((b): b is { kind: 'text'; content: string } => b.kind === 'text')
        .map((b) => b.content)
        .join('');
      if (!text.includes('scaffolded successfully')) continue;
      const match = text.match(/Team "([^"]+)" scaffolded successfully/);
      if (match?.[1]) return match[1];
    }
    return null;
  }, [state.messages]);

  const isComplete = !!scaffoldResult;

  return (
    <ConfigProvider theme={personalityTheme(ARCHITECT_ID)}>
      <div className="team-create-wizard">
        <style>{`
          .team-create-wizard {
            display: flex;
            flex-direction: column;
            height: 100%;
          }
          .team-create-wizard .wizard-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--ethos-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .team-create-wizard .wizard-header h3 {
            margin: 0;
          }
        `}</style>

        <div className="wizard-header">
          <Typography.Title level={4} style={{ margin: 0 }}>
            Team Architect
          </Typography.Title>
          <Typography.Text type="secondary">
            {isComplete ? 'Complete' : 'Designing your team'}
          </Typography.Text>
        </div>

        <MessageList
          messages={state.messages}
          currentTurn={state.currentTurn}
          emptyHint="The architect will guide you through creating a new team. Say hello to begin."
        />

        {isComplete ? (
          <Result
            status="success"
            title={`Team "${scaffoldResult}" created`}
            subTitle="Your new team is ready to go."
            extra={
              <Space>
                <Button type="primary" onClick={() => navigate('/teams')}>
                  Start Team
                </Button>
                <Button onClick={() => navigate('/teams')}>
                  Back to Teams
                </Button>
              </Space>
            }
          />
        ) : (
          <Composer
            personalityId={ARCHITECT_ID}
            disabled={state.isStreaming}
            onSend={sendMessage}
            placeholder={
              state.isStreaming
                ? 'Waiting for the architect...'
                : 'Describe the team you want to create...'
            }
          />
        )}
      </div>
    </ConfigProvider>
  );
}
