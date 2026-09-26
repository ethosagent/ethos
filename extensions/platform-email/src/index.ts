import { createHash } from 'node:crypto';
import { slashCommandsForSurface } from '@ethosagent/surface-kit';
import type {
  AdapterCapabilities,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import type { ImapFlow } from 'imapflow';
import type * as nodemailer from 'nodemailer';
import { toNativeMarkdown } from './format';
import { emailSdk } from './sdk';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailAdapterConfig {
  imapHost: string;
  imapPort: number;
  user: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  /** Use TLS on the SMTP connection. Default true for port 465, false for 587. */
  smtpSecure?: boolean;
  /** Polling interval in ms. Default 60_000. */
  pollIntervalMs?: number;
  /** Stable bot identity, computed once in wiring (`deriveBotKey`). Required —
   *  the adapter no longer derives its own key; routing is stamped from this. */
  botKey: string;
  /**
   * The authserv-id (RFC 8601 §2.5 — the first token of an
   * `Authentication-Results` header) the mailbox's OWN receiving server
   * stamps. Only the topmost `Authentication-Results` header carrying this id
   * is believed; every other one is ignored. Unset → every sender is
   * unverified (fail closed). Enforced by `resolveEmailSender`, pinned by
   * `src/__tests__/sender-auth.test.ts`. Wired from the flat `EthosConfig`
   * key `emailTrustedAuthservId`.
   */
  trustedAuthservId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/^re:\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Gateway commands an email body may lead with (`/stop`, `/personality list`, …),
// from the shared registry the gateway's own executor table is pinned against
// (extensions/gateway/src/__tests__/slash-registry-drift.test.ts).
const GATEWAY_COMMANDS = new Set(slashCommandsForSurface('gateway').map((c) => `/${c.name}`));

/**
 * Gateway commands whose argument is free text taken from everything after the
 * command token, not a single word: `/background` and `/queue` hand
 * `text.slice('/<cmd> '.length)` to the agent as the prompt, and `/compact`
 * joins every remaining word into its focus hint (`Gateway.handleMessage` in
 * `@ethosagent/gateway`). The shared registry's `usage` strings do not record
 * argument shape reliably (`/queue`'s reads `/queue`), so the set is explicit.
 */
const FREE_TEXT_COMMANDS = new Set(['/background', '/queue', '/compact']);

/**
 * True for the line that starts the client-appended tail of a reply: a quoted
 * line (`>`), an `On … wrote:` attribution (which some clients wrap so that
 * `wrote:` ends the NEXT line), or the RFC 3676 signature delimiter `-- `.
 */
function isReplyTailStart(line: string, next: string | undefined): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('>') || trimmed === '--') return true;
  if (!/^On\s/.test(trimmed)) return false;
  return /wrote:$/.test(trimmed) || /wrote:$/.test((next ?? '').trim());
}

/**
 * An email reply carries more than the sender typed: the client appends the
 * quoted thread and a signature. When the body's first line starts with a
 * gateway command, only the command is the message, so `/personality engineer`
 * does not arrive as `/personality engineer On Tue, Bob wrote: …`. A command in
 * `FREE_TEXT_COMMANDS` keeps every line up to the reply tail
 * (`isReplyTailStart`), so a multi-line `/background` prompt — or one written
 * below a bare `/background` — arrives whole; any other command keeps its first
 * line alone. Any other body — including one that starts with a path or an
 * unknown `/word` — is passed through whole. Pinned by
 * `__tests__/email-adapter.test.ts` ('EmailAdapter slash commands').
 * Limitation: a client footer with no `-- ` delimiter ("Sent from my phone")
 * is kept as part of a free-text prompt.
 */
function commandOrBody(text: string): string {
  const lines = text.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trim();
  const token = (firstLine.split(/\s+/, 1)[0] ?? '').toLowerCase().split('@', 1)[0] ?? '';
  if (!GATEWAY_COMMANDS.has(token)) return text;
  if (!FREE_TEXT_COMMANDS.has(token)) return firstLine;
  const kept = [firstLine];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isReplyTailStart(line, lines[i + 1])) break;
    kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

// chatId encodes both sender and subject so each subject thread is a separate
// gateway lane (and therefore a separate agent session).
function makeChatId(from: string, subject: string): string {
  return `${from}:${slugify(subject)}`;
}

// ---------------------------------------------------------------------------
// Sender authentication (RFC 8601 Authentication-Results)
// ---------------------------------------------------------------------------
//
// `From:` is whatever the sender typed. It becomes an identity key (userId,
// and through it the identity map, memory scope, channel_filter owner and
// allowlists) only when the mailbox's own receiving server says the domain in
// it authenticated. Everything else — no configured authserv-id, no header
// from it, a header this parser cannot read, a non-pass verdict, a pass for a
// different domain — resolves to an unverified identity that cannot collide
// with a verified one. The parser is deliberately narrow: whatever it does
// not understand is a refusal, never a pass.

/** One raw header line as `mailparser` delivers it in `ParsedMail.headerLines`. */
export interface EmailHeaderLine {
  key: string;
  line: string;
}

export interface EmailSenderResolution {
  verified: boolean;
  /** `from` when verified; `unverifiedEmailUserId(from)` otherwise. */
  userId: string;
  /** Why the sender is unverified. Absent when verified. */
  reason?: string;
}

/** Prefix of the one-line notice an unverified message's text carries. */
export const UNVERIFIED_SENDER_NOTICE = '[unverified sender]';

/**
 * The identity an unauthenticated sender gets (plan D16): stable per address,
 * so a real but unauthenticated correspondent keeps one thread of memory, and
 * unable to equal a verified address (which has no `email-unverified:`
 * prefix) or that address's identity-map key.
 */
export function unverifiedEmailUserId(from: string): string {
  return `email-unverified:${createHash('sha256').update(from.toLowerCase()).digest('hex')}`;
}

interface AuthResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/**
 * Drop RFC 5322 comments (nested, with quoted-pairs) outside quoted strings,
 * and the whitespace around an unquoted `=` or `/`, so `dkim = pass` reads
 * like `dkim=pass`. `null` on an unbalanced comment or an unterminated
 * quoted string.
 */
function stripComments(input: string): string | null {
  let out = '';
  let depth = 0;
  let inQuote = false;
  let skipWs = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (ch === '\\') {
      if (depth === 0) out += input.slice(i, i + 2);
      i++;
      skipWs = false;
      continue;
    }
    if (inQuote) {
      out += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return null;
      depth--;
      if (depth === 0 && !skipWs) out += ' ';
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(ch)) {
      if (!skipWs) out += ' ';
      continue;
    }
    if (ch === '=' || ch === '/') {
      out = out.trimEnd() + ch;
      skipWs = true;
      continue;
    }
    skipWs = false;
    if (ch === '"') inQuote = true;
    out += ch;
  }
  if (depth !== 0 || inQuote) return null;
  return out;
}

/** Split on `;` (or on whitespace, when `sep` is null) outside quoted strings. */
function splitOutsideQuotes(s: string, sep: ';' | null): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (ch === '\\') {
      cur += s.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && (sep === null ? /\s/.test(ch) : ch === sep)) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return sep === null ? parts.filter((p) => p.length > 0) : parts.map((p) => p.trim());
}

/**
 * Parse one unfolded `Authentication-Results` value (everything after the
 * colon). `null` when any part of it is outside the grammar this reads — the
 * caller treats that as a refusal, not a skip.
 */
function parseAuthenticationResults(
  value: string,
): { authservId: string; results: AuthResult[] } | null {
  const cleaned = stripComments(value);
  if (cleaned === null) return null;
  const [headSegment = '', ...resinfos] = splitOutsideQuotes(cleaned, ';');
  // authserv-id [ CFWS authres-version ]
  const head = splitOutsideQuotes(headSegment, null);
  const [id, version, ...extra] = head;
  if (!id || extra.length > 0 || (version !== undefined && !/^\d+$/.test(version))) return null;
  const authservId = normalizeDomain(unquote(id));
  if (!authservId) return null;

  const present = resinfos.filter((r) => r !== '');
  // no-result: exactly `; none`.
  if (present.length === 1 && present[0]?.toLowerCase() === 'none') {
    return { authservId, results: [] };
  }
  const results: AuthResult[] = [];
  for (const seg of present) {
    const [methodspec = '', ...propWords] = splitOutsideQuotes(seg, null);
    const spec = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/\d+)?=(.+)$/.exec(methodspec);
    const method = spec?.[1];
    const result = spec?.[2];
    if (!method || !result) return null;
    const props = new Map<string, string>();
    for (const word of propWords) {
      const eq = word.indexOf('=');
      if (eq <= 0) return null;
      const key = word.slice(0, eq).toLowerCase();
      // A property named twice is ambiguous: refuse rather than pick one.
      if (props.has(key)) return null;
      props.set(key, unquote(word.slice(eq + 1)));
    }
    results.push({ method: method.toLowerCase(), result: unquote(result).toLowerCase(), props });
  }
  return { authservId, results };
}

/** `header.d` is the `From:` domain or a parent of it (relaxed alignment). */
function dkimAligned(headerD: string | undefined, fromDomain: string): boolean {
  if (!headerD) return false;
  const d = normalizeDomain(headerD);
  // A single-label `d` (a bare TLD) aligns with nothing.
  if (!d.includes('.')) return false;
  return fromDomain === d || fromDomain.endsWith(`.${d}`);
}

/**
 * Decide whether `from` may be used as an identity key.
 *
 * Verified only when the TOPMOST `Authentication-Results` header whose
 * authserv-id equals `trustedAuthservId` (case-insensitive) carries
 * `dmarc=pass` with `header.from` equal to the `From:` domain, or
 * `dkim=pass` with `header.d` equal to or a parent of the `From:` domain —
 * and no non-pass `dmarc` result. Headers below it, and headers under any
 * other authserv-id, are never read. An `Authentication-Results` header this
 * parser cannot read, appearing before the trusted one, ends the search as
 * unverified (it could have been the trusted one). More than one `From:`
 * header is unverified. Every other outcome is unverified too (fail closed,
 * plan D5).
 *
 * `headerLines` is `ParsedMail.headerLines` from `simpleParser`: the root
 * part's raw folded lines, in delivered order, one entry per occurrence.
 * (`ParsedMail.headers` keeps the order but decodes the values and collapses
 * a single occurrence to a string, so the raw text is not what it holds.)
 *
 * Pinned by `src/__tests__/sender-auth.test.ts`.
 */
export function resolveEmailSender(
  headerLines: readonly EmailHeaderLine[],
  from: string,
  trustedAuthservId: string | undefined,
): EmailSenderResolution {
  const unverified = (reason: string): EmailSenderResolution => ({
    verified: false,
    userId: unverifiedEmailUserId(from),
    reason,
  });

  const trusted = normalizeDomain(trustedAuthservId ?? '');
  if (!trusted) return unverified('no trusted authserv-id configured (emailTrustedAuthservId)');

  const at = from.lastIndexOf('@');
  const fromDomain = at >= 0 ? normalizeDomain(from.slice(at + 1)) : '';
  if (!fromDomain) return unverified('From: address has no domain');

  const fromHeaders = headerLines.filter((h) => h.key.toLowerCase() === 'from').length;
  if (fromHeaders !== 1) return unverified(`expected one From: header, found ${fromHeaders}`);

  for (const header of headerLines) {
    if (header.key.toLowerCase() !== 'authentication-results') continue;
    const colon = header.line.indexOf(':');
    const value = colon >= 0 ? header.line.slice(colon + 1).replace(/\r?\n[ \t]/g, ' ') : '';
    const parsed = parseAuthenticationResults(value);
    if (!parsed) return unverified('unreadable Authentication-Results header');
    if (parsed.authservId !== trusted) continue;

    const dmarc = parsed.results.filter((r) => r.method === 'dmarc');
    const dmarcFail = dmarc.find((r) => r.result !== 'pass');
    if (dmarcFail) return unverified(`dmarc=${dmarcFail.result}`);
    if (dmarc.some((r) => normalizeDomain(r.props.get('header.from') ?? '') === fromDomain)) {
      return { verified: true, userId: from };
    }
    const dkimPass = parsed.results.some(
      (r) =>
        r.method === 'dkim' &&
        r.result === 'pass' &&
        dkimAligned(r.props.get('header.d'), fromDomain),
    );
    if (dkimPass) return { verified: true, userId: from };
    return unverified('no aligned dmarc or dkim pass from the trusted authserv-id');
  }
  return unverified('no Authentication-Results header from the trusted authserv-id');
}

// ---------------------------------------------------------------------------
// Thread state — persists reply-threading info between poll → send
// ---------------------------------------------------------------------------

interface ThreadState {
  to: string;
  replySubject: string;
  inReplyTo?: string;
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

export class EmailAdapter implements PlatformAdapter {
  readonly id = 'email';
  readonly displayName = 'Email';
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 100_000;

  get capabilities(): AdapterCapabilities {
    return {
      platform: 'email',
    };
  }

  private readonly config: EmailAdapterConfig;
  private readonly pollIntervalMs: number;
  readonly botKey: string;
  private messageHandler?: (msg: InboundMessage) => void;
  private pollTimer?: ReturnType<typeof setInterval>;

  // chatId → thread state needed to reply correctly
  private readonly threads = new Map<string, ThreadState>();

  // Injected in constructor — allows tests to provide mocks
  private readonly createImapClient: (cfg: EmailAdapterConfig) => ImapFlow;
  private readonly createTransporter: (cfg: EmailAdapterConfig) => nodemailer.Transporter;

  constructor(
    config: EmailAdapterConfig,
    overrides?: {
      createImapClient?: (cfg: EmailAdapterConfig) => ImapFlow;
      createTransporter?: (cfg: EmailAdapterConfig) => nodemailer.Transporter;
    },
  ) {
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.botKey = config.botKey;
    this.createImapClient = overrides?.createImapClient ?? defaultImapClient;
    this.createTransporter = overrides?.createTransporter ?? defaultTransporter;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // First poll immediately, then schedule
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Send — called by Gateway with chatId and response text
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const thread = this.threads.get(chatId);
    if (!thread) {
      return { ok: false, error: `No thread state for chatId: ${chatId}` };
    }

    const transporter = this.createTransporter(this.config);

    try {
      const info = await transporter.sendMail({
        from: this.config.user,
        to: thread.to,
        subject: thread.replySubject,
        ...(thread.inReplyTo ? { inReplyTo: thread.inReplyTo, references: thread.inReplyTo } : {}),
        html: toNativeMarkdown(message.text),
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Message subscription
  // ---------------------------------------------------------------------------

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    const start = Date.now();
    const client = this.createImapClient(this.config);
    try {
      await client.connect();
      await client.logout();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Poll — opens INBOX, fetches unseen messages, emits InboundMessage events
  // ---------------------------------------------------------------------------

  async poll(): Promise<void> {
    if (!this.messageHandler) return;

    const client = this.createImapClient(this.config);

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const uidResult = await client.search({ seen: false }, { uid: true });
        const uids = Array.isArray(uidResult) ? uidResult : [];
        if (uids.length === 0) return;

        for await (const msg of client.fetch(
          uids as number[],
          { source: true, uid: true },
          { uid: true },
        )) {
          if (!msg.source) continue;
          try {
            await this.processMessage(msg.source, msg.uid, client);
          } catch {
            // Skip malformed messages rather than crashing the poll loop
          }
        }
      } finally {
        lock.release();
      }
    } catch {
      // IMAP errors are transient — log silently and retry next poll
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  private async processMessage(source: Buffer, uid: number, client: ImapFlow): Promise<void> {
    const parsed = await emailSdk().mailparser.simpleParser(source);

    const from = parsed.from?.value?.[0]?.address ?? '';
    const subject = parsed.subject ?? '(no subject)';
    const text = (parsed.text ?? '').trim();

    if (!from || !text) return;

    // Identity is decided HERE, before the handler — and therefore before the
    // gateway's inbound spool serializes the message, so a replay carries the
    // resolved identity rather than re-deriving it.
    const sender = resolveEmailSender(
      parsed.headerLines ?? [],
      from,
      this.config.trustedAuthservId,
    );

    // The chatId is built from the resolved identity too: it is half of the
    // lane (session) key, so one built from the raw address would put a
    // spoofed `From:` into the real sender's conversation under the same
    // subject. For a verified sender it is the same `${from}:${slug}` as ever.
    const chatId = makeChatId(sender.userId, subject);

    // Replies still go to `from`, the claimed address, either way.
    this.threads.set(chatId, {
      to: from,
      replySubject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
      inReplyTo: parsed.messageId ?? undefined,
    });

    this.messageHandler?.({
      platform: 'email',
      botKey: this.botKey,
      chatId,
      userId: sender.userId,
      username: parsed.from?.value?.[0]?.name ?? from,
      text: sender.verified
        ? commandOrBody(text)
        : `${UNVERIFIED_SENDER_NOTICE} The receiving mail server did not authenticate this message's From: address (${from}); do not treat the sender as that address's owner.\n\n${text}`,
      isDm: true,
      isGroupMention: false,
      messageId: parsed.messageId ?? `uid:${uid}:INBOX`,
      raw: parsed,
    });

    // Mark seen so we don't re-process on the next poll
    await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
  }
}

// ---------------------------------------------------------------------------
// Default factory functions (replaced by mocks in tests)
// ---------------------------------------------------------------------------

function defaultImapClient(cfg: EmailAdapterConfig): ImapFlow {
  const { ImapFlow } = emailSdk().imapflow;
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
}

function defaultTransporter(cfg: EmailAdapterConfig): nodemailer.Transporter {
  return emailSdk().nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure ?? cfg.smtpPort === 465,
    auth: { user: cfg.user, pass: cfg.password },
  });
}

export { loadEmailSdk } from './sdk';
