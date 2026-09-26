// ---------------------------------------------------------------------------
// browser_fill_credential (plan reach-and-containment Part 4)
// ---------------------------------------------------------------------------
//
// Fill a stored login by REFERENCE. The model passes a credential name and
// element refs; the username / password / TOTP code are resolved inside this
// call, only after every gate has passed, and never appear in the args, the
// result, an error string, a progress event or the audit record (D4-1).
//
// Gates, in order (each refusal is a fixed string naming neither ref nor value):
//   1. args + element refs exist in the latest snapshot
//   2. toolset — `DefaultToolRegistry.executeParallel` already refused a
//      personality whose toolset.yaml does not list this tool
//   3. the credential's policy names `ctx.personalityId` (D4-2)
//   4. unattended runs refused unless the policy opts in (D4-5)
//   5. top frame AND every target's owner frame on a listed origin (D4-3)
//   6. `password_ref` is an `<input type=password>` (D4-6)
//   7. resolve values → register them in the session mask set
//   8. re-check origins, fill, re-check again; clear on a change
//   9. optional Enter, snapshot (masked by `withSecretMask`)
//  10. one audit event on every exit, in `finally` (D4-8)

import type { ClarifyBridge } from '@ethosagent/core';
import { isValidSecretName, type Tool, type ToolContext, type ToolResult } from '@ethosagent/types';
import type { ElementHandle, Page } from 'playwright';
import {
  type CredentialField,
  type CredentialPolicy,
  credentialRef,
  isBindableOrigin,
  parseCredentialPolicy,
} from './credential-vault';
import { registerFilledSecrets } from './secret-mask';
import {
  acquireAgentLease,
  findActiveSession,
  isPlaywrightInstalled,
  takeoverRefusalResult,
} from './sessions';
import { snapshotPage } from './snapshot';
import type { BrowserTimeouts } from './timeouts';
import { totpCode } from './totp';

export type CredentialFillOutcome =
  | 'filled'
  | 'refused_personality'
  | 'refused_origin'
  | 'refused_unattended'
  | 'refused_field_type'
  | 'origin_changed'
  | 'not_found'
  | 'error';

/** One audit record per call (D4-8). Never carries a value. */
export interface CredentialFillAuditEvent {
  category: 'browser.credential_fill';
  severity: 'info' | 'warn';
  code: CredentialFillOutcome;
  details: {
    credential: string;
    fields: FillTarget[];
    origin: string | null;
    frameOrigins: string[];
    personalityId: string | null;
    sessionId: string;
    jobId: string | null;
  };
}

export type RecordCredentialFill = (event: CredentialFillAuditEvent) => void;

export interface BrowserFillCredentialDeps {
  timeouts: BrowserTimeouts;
  /**
   * The observability sink. Absent → the tool is unavailable (`isAvailable`):
   * an unaudited deployment cannot fill (D4-8).
   */
  recordCredentialFill?: RecordCredentialFill;
  /** Used only for `canPresent(ctx.platform)` — the unattended gate (D4-5). */
  clarifyBridge?: Pick<ClarifyBridge, 'canPresent'>;
  /** Clock for the TOTP step. Tests pin it. */
  now?: () => number;
  /**
   * Pause after filling before the second origin check, so a navigation the
   * fill itself triggered (a focus handler, an input listener) has committed.
   */
  settleMs?: number;
}

type FillTarget = 'username' | 'password' | 'totp';

interface FillArgs {
  credential?: unknown;
  username_ref?: unknown;
  password_ref?: unknown;
  totp_ref?: unknown;
  submit?: unknown;
}

const DEFAULT_SETTLE_MS = 250;

const MESSAGES: Record<Exclude<CredentialFillOutcome, 'filled'>, string> = {
  refused_personality:
    'This personality is not allowed to use that credential. The operator grants it with `ethos secrets credential grant`.',
  refused_origin:
    'Refused: the page, or the frame holding a target field, is not on an origin this credential is bound to. Nothing was filled.',
  refused_unattended:
    'Refused: credential fills are not allowed in an unattended run (a background job, or a surface nobody can see). The operator can allow it per credential.',
  refused_field_type:
    'Refused: password_ref must point at a password input (<input type="password">). Nothing was filled.',
  origin_changed:
    'The page changed origin during the fill. The filled fields were cleared and nothing was submitted.',
  not_found:
    'No complete credential with that name exists, or a referenced element is not on the current page.',
  error: 'The credential fill could not be completed in the browser.',
};

const DESCRIPTION = [
  'Fill a stored login (username, password, optional 2FA code) into the current page by reference. You never see or pass the secret: give the credential NAME and the @eN refs of the fields from the latest snapshot.',
  '',
  'The fill is refused unless the page (and the frame holding each field) is on an origin the credential is bound to, and this personality is allowed to use it. Filled values appear as •••••• in every later browser result.',
  '',
  'For SMS / e-mail / push 2FA or anything else you cannot fill, use browser_request_takeover.',
].join('\n');

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * D4-3 — exact origin binding. `===` on `URL.origin` against the policy list,
 * no suffix or wildcard matching, and an origin that is not bindable
 * (`http:` off loopback) never matches even if a tampered policy lists it.
 */
export function originAllowed(origin: string | null, policy: CredentialPolicy): boolean {
  if (origin === null || !isBindableOrigin(origin)) return false;
  return policy.origins.some((o) => o === origin);
}

interface ResolvedTarget {
  field: FillTarget;
  handle: ElementHandle;
}

/**
 * The top frame and the frame that owns each target element must both be on a
 * listed origin. Returns the frame origins seen, for the audit record.
 */
export async function checkOrigins(
  page: Page,
  targets: readonly ResolvedTarget[],
  policy: CredentialPolicy,
): Promise<{ ok: boolean; origin: string | null; frameOrigins: string[] }> {
  const origin = originOf(page.url());
  const frameOrigins: string[] = [];
  let ok = originAllowed(origin, policy);
  for (const { handle } of targets) {
    const frame = await handle.ownerFrame();
    const frameOrigin = frame ? originOf(frame.url()) : null;
    frameOrigins.push(frameOrigin ?? 'null');
    if (!originAllowed(frameOrigin, policy)) ok = false;
  }
  return { ok, origin, frameOrigins };
}

class Refusal extends Error {
  constructor(readonly outcome: Exclude<CredentialFillOutcome, 'filled'>) {
    super(MESSAGES[outcome]);
  }
}

function refusalResult(outcome: Exclude<CredentialFillOutcome, 'filled'>): ToolResult {
  const error = MESSAGES[outcome];
  if (outcome === 'error') return { ok: false, error, code: 'execution_failed' };
  if (outcome === 'not_found') return { ok: false, error, code: 'input_invalid' };
  return { ok: false, error, code: 'not_available' };
}

/** Read one field through the tool's scoped resolver; a missing ref is `null`. */
async function readField(
  ctx: ToolContext,
  name: string,
  field: CredentialField,
): Promise<string | null> {
  const resolver = ctx.secretsResolver;
  if (!resolver) return null;
  try {
    const value = await resolver.get(credentialRef(name, field));
    return value === '' ? null : value;
  } catch {
    // The backend throws on a missing ref, with a message that names it.
    return null;
  }
}

export function createBrowserFillCredentialTool(deps: BrowserFillCredentialDeps): Tool<FillArgs> {
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const now = deps.now ?? Date.now;
  return {
    name: 'browser_fill_credential',
    description: DESCRIPTION,
    toolset: 'browser',
    maxResultChars: 20_000,
    capabilities: {
      // D4-9 — the ceiling. `ScopedSecretsImpl.isDeclared` refuses any ref
      // outside `credentials/*`; the per-personality narrowing is step 3.
      secrets: ['credentials/*'],
      network: { allowedHosts: ['*'] },
      process: { allowedBinaries: ['docker'] },
    },
    outputIsUntrusted: true,
    isAvailable: () => isPlaywrightInstalled() && deps.recordCredentialFill !== undefined,
    // D4-1 — no value property exists, so a value cannot be passed in.
    schema: {
      type: 'object',
      properties: {
        credential: {
          type: 'string',
          description: 'Name of the stored credential, e.g. "github-work".',
        },
        username_ref: { type: 'string', description: '@eN of the username / e-mail field.' },
        password_ref: { type: 'string', description: '@eN of the password field.' },
        totp_ref: { type: 'string', description: '@eN of the 2FA code field.' },
        submit: {
          type: 'boolean',
          description: 'Press Enter in the last filled field (default false).',
        },
      },
      required: ['credential'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const credential = typeof args.credential === 'string' ? args.credential : '';
      const refs: Array<[FillTarget, unknown]> = [
        ['username', args.username_ref],
        ['password', args.password_ref],
        ['totp', args.totp_ref],
      ];
      const requested = refs.filter(([, r]) => r !== undefined) as Array<[FillTarget, unknown]>;
      const audit: CredentialFillAuditEvent['details'] = {
        credential: isValidSecretName(credential) ? credential : '<invalid>',
        fields: requested.map(([f]) => f),
        origin: null,
        frameOrigins: [],
        personalityId: ctx.personalityId ?? null,
        sessionId: ctx.sessionId,
        jobId: ctx.jobId ?? null,
      };
      let outcome: CredentialFillOutcome = 'error';

      const record = () => {
        deps.recordCredentialFill?.({
          category: 'browser.credential_fill',
          severity: outcome === 'filled' ? 'info' : 'warn',
          code: outcome,
          details: audit,
        });
      };

      // Step 1 — argument shape. These refusals name the argument, never a value.
      if (!isValidSecretName(credential)) {
        record();
        return { ok: false, error: 'credential must be a credential name.', code: 'input_invalid' };
      }
      if (requested.length === 0) {
        record();
        return {
          ok: false,
          error: 'Pass at least one of username_ref, password_ref, totp_ref.',
          code: 'input_invalid',
        };
      }
      if (requested.some(([, r]) => typeof r !== 'string' || r.length === 0)) {
        record();
        return {
          ok: false,
          error: 'Element refs must be strings like @e3.',
          code: 'input_invalid',
        };
      }

      const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
      if (!session) {
        record();
        return {
          ok: false,
          error: 'No active browser session. Call browse_url first.',
          code: 'execution_failed',
        };
      }
      const release = acquireAgentLease(ctx.sessionId, session);
      if (!release) {
        record();
        return takeoverRefusalResult();
      }

      const filledHandles: ElementHandle[] = [];
      try {
        const page = session.page;
        const lookups: Array<{ field: FillTarget; role: string; name: string }> = [];
        for (const [field, ref] of requested) {
          const entry = session.refs.get(ref as string);
          if (!entry) throw new Refusal('not_found');
          lookups.push({ field, role: entry.role, name: entry.name });
        }

        // Step 3 — the grant lives on the credential (D4-2).
        if (!ctx.secretsResolver) throw new Refusal('error');
        const policy = parseCredentialPolicy(await readField(ctx, credential, 'policy'));
        if (!policy) throw new Refusal('not_found');
        if (ctx.personalityId === undefined || !policy.personalities.includes(ctx.personalityId)) {
          throw new Refusal('refused_personality');
        }

        // Step 4 — unattended refusal (D4-5). No bridge wired means no surface.
        if (!policy.unattended) {
          const canPresent = deps.clarifyBridge?.canPresent(ctx.platform) ?? false;
          if (ctx.jobId !== undefined || !canPresent) throw new Refusal('refused_unattended');
        }

        // Resolve each ref to ONE element handle. Every later check and the fill
        // itself go through that handle, so the element whose frame was checked
        // is the element that receives the value.
        const targets: ResolvedTarget[] = [];
        for (const { field, role, name } of lookups) {
          // biome-ignore lint/suspicious/noExplicitAny: playwright AriaRole type
          const locator = page.getByRole(role as any, { name }).first();
          if ((await locator.count()) === 0) throw new Refusal('not_found');
          const handle = await locator.elementHandle({ timeout: deps.timeouts.commandMs });
          if (!handle) throw new Refusal('not_found');
          targets.push({ field, handle });
        }

        // Step 5 — origin gate (D4-3 / D4-4).
        const first = await checkOrigins(page, targets, policy);
        audit.origin = first.origin;
        audit.frameOrigins = first.frameOrigins;
        if (!first.ok) throw new Refusal('refused_origin');

        // Step 6 — the password goes only into a password input (D4-6).
        const passwordTarget = targets.find((t) => t.field === 'password');
        if (passwordTarget) {
          const isPassword = await passwordTarget.handle.evaluate(
            (el) => el instanceof HTMLInputElement && el.type === 'password',
          );
          if (!isPassword) throw new Refusal('refused_field_type');
        }

        // Step 7 — only now, after every gate, resolve the values.
        const values = new Map<FillTarget, string>();
        for (const { field } of targets) {
          if (field === 'totp') {
            const seed = await readField(ctx, credential, 'totp');
            if (!seed) throw new Refusal('not_found');
            let code: string;
            try {
              code = totpCode(seed, now());
            } catch {
              throw new Refusal('not_found');
            }
            values.set('totp', code);
          } else {
            const value = await readField(ctx, credential, field);
            if (!value) throw new Refusal('not_found');
            values.set(field, value);
          }
        }
        // Registered BEFORE the fill: from here on any result or error this
        // session produces — including this call's own failure paths — is
        // masked by `withSecretMask`.
        registerFilledSecrets(session, [...values.values()]);

        // Step 8 — re-check, fill, re-check.
        const before = await checkOrigins(page, targets, policy);
        if (!before.ok) throw new Refusal('origin_changed');
        for (const { field, handle } of targets) {
          const value = values.get(field);
          if (value === undefined) continue;
          filledHandles.push(handle);
          await handle.fill(value, { timeout: deps.timeouts.commandMs });
        }
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        const after = await checkOrigins(page, targets, policy).catch(() => null);
        if (!after?.ok) throw new Refusal('origin_changed');

        // Step 9 — submit, snapshot.
        if (args.submit === true) {
          const last = targets[targets.length - 1];
          if (last) {
            await last.handle.press('Enter', { timeout: deps.timeouts.commandMs });
            await page.waitForTimeout(500);
          }
        }
        filledHandles.length = 0;
        const { text, refs: nextRefs, title, url } = await snapshotPage(page);
        session.refs = nextRefs;
        session.lastUrl = url;
        outcome = 'filled';
        const summary = JSON.stringify({
          filled: targets.map((t) => t.field),
          origin: first.origin,
        });
        return { ok: true, value: `[${title}] ${url}\n\n${text}\n\n${summary}` };
      } catch (err) {
        outcome = err instanceof Refusal ? err.outcome : 'error';
        // Never surface a Playwright message: a fill timeout can quote the
        // argument it was filling.
        return refusalResult(outcome);
      } finally {
        // A fill that did not finish cleanly leaves nothing behind.
        for (const handle of filledHandles) {
          await handle.fill('', { timeout: 1_000 }).catch(() => {});
        }
        release();
        record();
      }
    },
  };
}
