// Removing a model something still uses (plan/phases/model-registry.md T2.12,
// D17 row 6a). This dialog is the UI for `modelRegistry.remove`'s `referenced`
// refusal: it lists every referent the server named, then offers Cancel,
// "Repoint them to <alias>" and "Remove anyway". Nothing is repointed unless
// the operator picks the target; "Remove anyway" leaves every referent naming
// the removed alias, to refuse at turn time and say why.

import type { ModelReferent, ModelRegistryRefusal } from '@ethosagent/web-contracts';
import { Button, Modal, Select } from 'antd';
import { useState } from 'react';
import { referentKey } from '../lib/model-registry';
import { MONO, ReferentItem, RefusalNotice } from './model-registry-notices';

export function RemoveModelDialog({
  alias,
  referents,
  choices,
  refusal,
  pending,
  onCancel,
  onRepoint,
  onForce,
}: {
  alias: string;
  referents: readonly ModelReferent[];
  /** Aliases the referents may be repointed to — every other entry. */
  choices: readonly string[];
  refusal: ModelRegistryRefusal | null;
  pending: 'repoint' | 'force' | null;
  onCancel: () => void;
  onRepoint: (to: string) => void;
  onForce: () => void;
}) {
  const [target, setTarget] = useState<string | undefined>(choices[0]);
  const secondary = { color: 'var(--text-secondary)', margin: 0 };

  return (
    <Modal
      open
      onCancel={onCancel}
      footer={null}
      title={
        <>
          Remove <span style={MONO}>{alias}</span>?
        </>
      }
    >
      <div
        className="model-remove-dialog"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <p style={secondary}>
          <span style={MONO}>{alias}</span> is used by:
        </p>
        <ul
          style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {referents.map((r) => (
            <ReferentItem key={referentKey(r)} referent={r} />
          ))}
        </ul>
        <p style={secondary}>
          Removing it stops those from running until they're pointed at another model.
        </p>
        {refusal ? <RefusalNotice refusal={refusal} /> : null}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <Button type="text" onClick={onCancel}>
            Cancel
          </Button>
          {choices.length > 0 && target !== undefined ? (
            <>
              <Select
                aria-label="Repoint to"
                value={target}
                onChange={(value: string) => setTarget(value)}
                options={choices.map((c) => ({ value: c, label: <span style={MONO}>{c}</span> }))}
                style={{ minWidth: 120 }}
              />
              <Button
                loading={pending === 'repoint'}
                disabled={pending !== null}
                onClick={() => onRepoint(target)}
              >
                Repoint them to {target}
              </Button>
            </>
          ) : null}
          <Button
            danger
            loading={pending === 'force'}
            disabled={pending !== null}
            onClick={onForce}
          >
            Remove anyway
          </Button>
        </div>
      </div>
    </Modal>
  );
}
