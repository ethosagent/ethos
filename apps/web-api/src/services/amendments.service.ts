import { EthosError } from '@ethosagent/types';
import type {
  AmendmentRecordView,
  AmendmentReviewView,
  AmendmentStatusView,
} from '@ethosagent/web-contracts';
import type { AmendmentReview, AmendmentService } from '@ethosagent/wiring';

// The web's READ-ONLY view of personality self-amendments (plan
// personality-memory-boundary-and-self-amendment G2, D30).
//
// It holds `AmendmentReader` — `list` and `get` of the loop's
// `AmendmentService` (`CreateAgentLoopResult.amendments`), never `apply`,
// `decline` or `rollback`. Those are the TTY-gated CLI's
// (apps/ethos/src/commands/personality-amendments.ts, G2-1 (c)); web apply is
// v1.1. Cookie-only: `amendments` is absent from `SCOPE_MAP`
// (middleware/dual-auth.ts). Both pinned by
// __tests__/services/amendments.service.test.ts.

/** The only part of `AmendmentService` the web holds. */
export type AmendmentReader = Pick<AmendmentService, 'list' | 'get'>;

export interface AmendmentsListInput {
  personalityId?: string | undefined;
  statuses?: AmendmentStatusView[] | undefined;
}

export class AmendmentsService {
  /**
   * `reader` is resolved per call: an onboarding-mode host has no loop, and so
   * no service, until `bindAgentLoop` installs one. Absent → `NOT_CONFIGURED`,
   * never an empty list that would read as "nothing is waiting".
   */
  constructor(private readonly reader: () => AmendmentReader | undefined) {}

  async list(input: AmendmentsListInput): Promise<{ amendments: AmendmentRecordView[] }> {
    const amendments = await this.requireReader().list({
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.statuses ? { status: input.statuses } : {}),
    });
    return { amendments };
  }

  /** `null` for an unknown id — `rpc/amendments.ts` answers it `NOT_FOUND` (404). */
  async get(amendmentId: string): Promise<{ review: AmendmentReviewView } | null> {
    const review = await this.requireReader().get(amendmentId);
    return review ? { review: toView(review) } : null;
  }

  private requireReader(): AmendmentReader {
    const reader = this.reader();
    if (reader) return reader;
    throw new EthosError({
      code: 'NOT_CONFIGURED',
      cause: 'The agent is not running in this process yet, so amendments cannot be read',
      action: 'Finish setup, or run `ethos personality amendments list` in a terminal.',
    });
  }
}

/** The review minus the raw live and after bytes — `textDiff` carries the change. */
function toView(review: AmendmentReview): AmendmentReviewView {
  return {
    record: review.record,
    file: review.file,
    personality: review.personality,
    liveHash: review.liveHash,
    stale: review.stale,
    interruptedApply: review.interruptedApply,
    ...(review.opsProblem !== undefined ? { opsProblem: review.opsProblem } : {}),
    expectedAfterHash: review.expectedAfterHash,
    textDiff: review.textDiff,
    permissionDiff: review.permissionDiff,
    notCompared: review.notCompared,
    flags: review.flags,
  };
}
