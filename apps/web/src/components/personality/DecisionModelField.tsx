import type { Personality } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Form, Segmented, Select, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { decisionKeys } from '../../pages/settings/lib/decision-models';
import { rpc } from '../../rpc';
import {
  DECISION_SITE_MODES,
  DECISION_SITE_ROWS,
  type DecisionFieldValue,
  type DecisionSiteMode,
  decisionProviderNote,
  decisionProviderOptions,
  decisionSiteNote,
} from './decisionModel';

// Edit → Config › Decision model (plan decision-provider-personality §9, PD9):
// which decision model this personality uses (`decisions.provider`) and, per
// site, whether it runs (`decisions.sites.<site>`: off · shadow · on).
//
// The select lists the decision models the operator ADDED in Settings → Models
// (`decisions.list` `providers`) plus None; with none added it is disabled and
// links there. The three site rows stay disabled until a model is chosen: a
// site without `decisions.provider` never runs (PD10). Every note comes from
// the server's resolution (`Personality.decisions.resolved`, the character
// sheet's own resolver — see ./decisionModel).
//
// Controlled and held outside the Antd form, like the model declaration and the
// voice block: the parent latches dirty on change and sends the patch
// (`decisionsUpdateInput`) only once the field was touched. Raw layout, no Card
// (DESIGN.md "Cards earn existence"); mode words in Geist Mono like every other
// config literal; no new colour.

const MONO: CSSProperties = { fontFamily: 'var(--font-mono, "Geist Mono", monospace)' };

const NOTE: CSSProperties = { display: 'block', fontSize: 12, marginTop: 4 };

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) max-content',
  alignItems: 'center',
  gap: '2px 12px',
  padding: '8px 0',
  borderTop: '1px solid var(--border-subtle)',
};

export function DecisionModelField({
  value,
  onChange,
  stored,
  approvalMode,
}: {
  value: DecisionFieldValue;
  onChange: (next: DecisionFieldValue) => void;
  /** The personality's saved `decisions` block, with the server's `resolved` rows. */
  stored: Personality['decisions'];
  /** This form's `safety.approvalMode`, saved or not. */
  approvalMode: 'manual' | 'smart' | 'off' | undefined;
}) {
  const listQuery = useQuery({
    queryKey: decisionKeys.list(),
    queryFn: () => rpc.decisions.list(),
  });
  const providers = listQuery.data?.providers ?? [];
  const noneAdded = listQuery.data !== undefined && providers.length === 0 && !stored?.provider;
  const sitesDisabled = value.provider === '';
  const providerNote = decisionProviderNote(value, stored);

  return (
    <Form.Item
      label="Decision model"
      extra="shadow asks and records the answer while today’s check still decides. on lets the answer decide."
    >
      <div className="personality-decision-model">
        {listQuery.isError ? (
          <Typography.Text type="danger">
            Could not load decision models: {listQuery.error.message}
          </Typography.Text>
        ) : (
          <Select
            aria-label="Decision model"
            style={{ width: '100%' }}
            loading={listQuery.isLoading}
            disabled={listQuery.isLoading || noneAdded}
            value={value.provider}
            onChange={(provider: string) => onChange({ ...value, provider })}
            options={decisionProviderOptions(providers, stored?.provider)}
          />
        )}
        {noneAdded ? (
          <Typography.Text type="secondary" style={NOTE}>
            No decision models yet. Add one in <Link to="/settings/models">Settings → Models</Link>.
          </Typography.Text>
        ) : null}
        {providerNote ? (
          <Typography.Text type="warning" className="decision-provider-note" style={NOTE}>
            ⚠ {providerNote}
          </Typography.Text>
        ) : null}
        <div style={{ marginTop: 8 }}>
          {DECISION_SITE_ROWS.map(({ site, label, help }) => {
            const note = decisionSiteNote({ site, value, stored, approvalMode });
            return (
              <div key={site} data-site={site} style={ROW}>
                <span style={{ fontSize: 14 }}>{label}</span>
                <Segmented<DecisionSiteMode>
                  size="small"
                  aria-label={label}
                  disabled={sitesDisabled}
                  value={value.sites[site]}
                  onChange={(mode) =>
                    onChange({ ...value, sites: { ...value.sites, [site]: mode } })
                  }
                  options={DECISION_SITE_MODES.map((mode) => ({
                    value: mode,
                    label: <span style={MONO}>{mode}</span>,
                  }))}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, gridColumn: '1 / -1' }}>
                  {help}
                </Typography.Text>
                {note ? (
                  <Typography.Text
                    type="warning"
                    className="decision-site-note"
                    style={{ fontSize: 12, gridColumn: '1 / -1' }}
                  >
                    ⚠ {note}
                  </Typography.Text>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Form.Item>
  );
}
