import type { BackgroundJobEventType } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { BackgroundJobEventTypeSchema } from '../schema/goals-jobs';

// `BackgroundJobEventType` (packages/types) and `BackgroundJobEventTypeSchema`
// (the wire enum) are two hand-kept lists of the same set. Nothing else pins
// them, and a row type missing from the schema fails `tasks.get` for any job
// whose trail contains it. `satisfies Record<…, true>` makes the union
// enumerable: a new union member without a key here is a compile error, and a
// key without a schema option (or vice versa) fails the comparison below.
const UNION_MEMBERS = {
  queued: true,
  claimed: true,
  running: true,
  heartbeat: true,
  spend: true,
  cancel_requested: true,
  tool_headline: true,
  tool_end: true,
  text: true,
  blocked: true,
  resumed: true,
  artifact_change: true,
  runner_log: true,
  steer: true,
  done: true,
  failed: true,
  aborted: true,
  stale: true,
  expired: true,
  recovered: true,
} satisfies Record<BackgroundJobEventType, true>;

describe('BackgroundJobEventType wire drift', () => {
  it('the schema options equal the type union', () => {
    expect([...BackgroundJobEventTypeSchema.options].sort()).toEqual(
      Object.keys(UNION_MEMBERS).sort(),
    );
  });
});
