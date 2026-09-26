// N5c (plan ux-feedback-and-config-clarity) — the one loading block, so pages
// stop hand-rolling `display: grid; placeItems: center` around a bare <Spin>.
// A `role="status"` region: screen readers hear the label, sighted users see
// the spinner plus the same words (DESIGN.md — never a signal by one channel
// alone). Copy is practical ("Loading config…"), never marketing.

import { Spin } from 'antd';
import './state-blocks.css';

export function LoadingState({
  label = 'Loading…',
  height = 200,
}: {
  /** What is loading, concretely — "Loading config…", "Loading outbox…". */
  label?: string;
  /** Reserved height so the content's arrival does not shift the page. */
  height?: number;
}) {
  return (
    <div className="state-loading" role="status" style={{ minHeight: height }}>
      <Spin />
      <span className="state-loading-label">{label}</span>
    </div>
  );
}
