import type {
  ContextInjector,
  InitiativeStore,
  InjectionResult,
  PromptContext,
} from '@ethosagent/types';

/** After the static sections and the memory snapshot; the index is the last thing the model reads. */
export const INITIATIVE_INDEX_PRIORITY = 30;
const DEFAULT_MAX_LINES = 12;
export const INITIATIVE_INDEX_HEADER = 'Your initiatives (from your ledger)';

export interface InitiativeIndexInjectorDeps {
  /** The one ledger method the index needs; not the whole store. */
  store: Pick<InitiativeStore, 'indexLines'>;
  /**
   * Resolves false when the ledger does not exist yet, so a user who never used the
   * feature never causes `initiatives.db` to be created. Absent means always ready.
   */
  ready?: () => Promise<boolean>;
  /** False means the personality has initiatives off (settings or kill switch): no index. Absent means on. */
  isEnabled?: (personalityId: string) => boolean;
  /** Called when the ledger cannot be read; the turn proceeds without the index. */
  onError?: (err: unknown) => void;
  maxLines?: number;
}

/**
 * The ledger index for chat turns: one line per active initiative and open exploration,
 * rendered as an `append` section (prompt tail), so a ledger change never moves the static
 * prefix (packages/wiring/src/__tests__/initiative-index-prefix.test.ts). Owner guidance
 * is not injected. A shared turn gets nothing: the ledger holds private run output.
 */
export class InitiativeIndexInjector implements ContextInjector {
  readonly id = 'initiative-index';
  readonly priority = INITIATIVE_INDEX_PRIORITY;

  constructor(private readonly deps: InitiativeIndexInjectorDeps) {}

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    if (ctx.personalityId === undefined || ctx.roomAudience !== 'private') return null;
    if (this.deps.isEnabled && !this.deps.isEnabled(ctx.personalityId)) return null;
    try {
      if (this.deps.ready && !(await this.deps.ready())) return null;
      const lines = this.deps.store.indexLines(
        ctx.personalityId,
        this.deps.maxLines ?? DEFAULT_MAX_LINES,
      );
      if (lines.length === 0) return null;
      return {
        content: `## ${INITIATIVE_INDEX_HEADER}\n\n${lines.join('\n')}`,
        position: 'append',
      };
    } catch (err) {
      this.deps.onError?.(err);
      return null;
    }
  }
}
