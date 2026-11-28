import type { InitiativeDecideInput } from '@ethosagent/web-contracts';
import { useNavigate } from 'react-router-dom';
import { useInitiativeDecide } from '../../features/initiatives/api/mutations';
import { useInitiativeActivity, useInitiativeDetail } from '../../features/initiatives/api/queries';
import { formatUsd } from '../../lib/usage-format';
import { LoadingState } from '../ui/LoadingState';
import { ActivityList } from './ActivityList';
import {
  briefChoices,
  DecisionButtons,
  proposalChoices,
  selfStartChoices,
} from './DecisionButtons';
import { FileRows } from './FileRows';
import { ShowFile } from './ShowFile';

export function InitiativeDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const detail = useInitiativeDetail(id);
  const activity = useInitiativeActivity(id);
  const decide = useInitiativeDecide();

  if (detail.isLoading) return <LoadingState label="Loading initiative…" />;
  if (detail.error || !detail.data) {
    return (
      <div className="initiative-muted">
        {detail.error instanceof Error ? detail.error.message : 'Could not load this initiative.'}
      </div>
    );
  }
  const { initiative, guidance, yaml, versions, explorations } = detail.data;

  const onDecide = (input: InitiativeDecideInput) => {
    decide.mutate(input, {
      onSuccess: (out) => {
        // Make it mine: the server returns the chat deep link that starts setup.
        if (input.gate === 'self_start' && input.verdict === 'make_mine' && out.chatLink) {
          navigate(out.chatLink);
        }
      },
    });
  };

  return (
    <div className="initiative-detail" data-testid="initiative-detail">
      <h2 className="initiative-title">{initiative.title}</h2>
      <p className="initiative-muted">
        To change this initiative, tell the agent in chat. This page is read-only.
      </p>
      {decide.error ? (
        <div role="alert" className="initiative-error">
          {decide.error instanceof Error ? decide.error.message : String(decide.error)}
        </div>
      ) : null}

      {initiative.state === 'self_started' ? (
        <section>
          <div className="initiative-section-label">The agent started this</div>
          <DecisionButtons
            choices={selfStartChoices(initiative.id)}
            busy={decide.isPending}
            onDecide={onDecide}
          />
        </section>
      ) : null}

      <section>
        <div className="initiative-section-label">Explorations</div>
        {explorations.length === 0 ? <div className="initiative-muted">None yet.</div> : null}
        {explorations.map((e) => (
          <div key={e.id} className="initiative-exploration" data-exploration-id={e.id}>
            <div>
              <span className="initiative-mono">{e.id}</span> {e.question}
            </div>
            <div className="initiative-muted">
              {e.state} · {formatUsd(e.spentUsd)} of {formatUsd(e.budgetUsd)} · due {e.deadline}
            </div>
            {e.briefMd ? <pre className="initiative-brief">{e.briefMd}</pre> : null}
            {e.state === 'briefed' ? (
              <DecisionButtons
                choices={briefChoices(e.id, e.recommendedOption)}
                busy={decide.isPending}
                onDecide={onDecide}
              />
            ) : null}
            {e.state === 'proposed' ? (
              <DecisionButtons
                choices={proposalChoices(e.id)}
                busy={decide.isPending}
                onDecide={onDecide}
              />
            ) : null}
          </div>
        ))}
      </section>

      <section>
        <div className="initiative-section-label">Initiative file</div>
        <FileRows file={initiative} guidance={guidance} />
        <ShowFile yaml={yaml} versions={versions} />
      </section>

      <section>
        <div className="initiative-section-label">Activity</div>
        <ActivityList windows={activity.data?.windows ?? []} />
      </section>
    </div>
  );
}
