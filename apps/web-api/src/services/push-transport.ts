// The push delivery seam (mobile-app plan S5, D11). ONE implementation,
// `ExpoPushTransport`: the Expo Push Service holds the APNs/FCM credentials on
// the app's behalf, so `ethos serve` needs outbound https and nothing else.
// `push.transport: none` in config.yaml means no transport is built at all
// (`createWebApi`), not a second implementation.
//
// No retry machinery by design: a 5xx or an unreachable Expo is returned to the
// caller — `push.test` renders it as the Settings `✗` row — and an event push
// that fails is dropped. One delayed receipt check per send turns a
// `DeviceNotRegistered` receipt into a removed device row.

/** One Expo push message. Field names are Expo's; `collapseId` becomes
 *  `apns-collapse-id` (REPLACES a delivered notification), `threadId` only
 *  groups (D11, R9d). */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  categoryId?: string;
  collapseId?: string;
  threadId?: string;
  interruptionLevel: 'active' | 'time-sensitive';
  mutableContent: true;
}

export type PushSendResult = { ok: true; sent: number } | { ok: false; error: string };

export interface PushTransport {
  send(messages: PushMessage[]): Promise<PushSendResult>;
  /** Cancel pending receipt checks. */
  close(): void;
}

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const DEFAULT_RECEIPT_DELAY_MS = 60_000;

/** Who holds the push credential, named in every failure row so "my server is
 *  broken" reads differently from "the push project is down" (T-DIST). The
 *  Expo project is one individual's account (plan Risks). */
export const EXPO_PROJECT_OWNER = 'mitesh';

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoPushTransportOptions {
  /** The Expo push access token (`providers/expo/accessToken` in the secrets
   *  vault — `ethos secrets set providers/expo/accessToken <token>`), read per
   *  send so setting it needs no restart. Undefined → the
   *  request goes out WITHOUT `Authorization`, which Expo accepts only while the
   *  project's enhanced push security is off; with it on, Expo answers 401 and
   *  `push.test` shows `Expo · 401`. */
  accessToken: () => Promise<string | undefined>;
  /** A ticket or receipt said `DeviceNotRegistered` — remove the token's rows. */
  onDeviceNotRegistered: (expoPushToken: string) => void;
  fetch?: typeof fetch;
  receiptDelayMs?: number;
}

function failure(what: string): PushSendResult {
  return { ok: false, error: `Expo · ${what} · project ${EXPO_PROJECT_OWNER}` };
}

export class ExpoPushTransport implements PushTransport {
  private readonly fetchFn: typeof fetch;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ExpoPushTransportOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async send(messages: PushMessage[]): Promise<PushSendResult> {
    if (messages.length === 0) return { ok: true, sent: 0 };
    let res: Response;
    try {
      res = await this.post(SEND_URL, messages);
    } catch {
      return failure('unreachable');
    }
    if (!res.ok) return failure(String(res.status));
    const body = (await res.json().catch(() => null)) as { data?: ExpoTicket[] } | null;
    // Tickets come back in message order; a receipt names only its ticket id,
    // so remember which token each id belongs to.
    const receiptTokens = new Map<string, string>();
    let firstError: string | undefined;
    let sent = 0;
    (body?.data ?? []).forEach((ticket, i) => {
      const to = messages[i]?.to;
      if (ticket.status === 'ok') {
        sent++;
        if (ticket.id && to) receiptTokens.set(ticket.id, to);
        return;
      }
      const code = ticket.details?.error ?? ticket.message ?? 'error';
      if (code === 'DeviceNotRegistered' && to) this.opts.onDeviceNotRegistered(to);
      firstError ??= code;
    });
    if (receiptTokens.size > 0) this.checkReceiptsLater(receiptTokens);
    return firstError ? failure(firstError) : { ok: true, sent };
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private checkReceiptsLater(receiptTokens: Map<string, string>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.checkReceipts(receiptTokens).catch(() => {});
    }, this.opts.receiptDelayMs ?? DEFAULT_RECEIPT_DELAY_MS);
    timer.unref?.();
    this.timers.add(timer);
  }

  private async checkReceipts(receiptTokens: Map<string, string>): Promise<void> {
    const res = await this.post(RECEIPTS_URL, { ids: [...receiptTokens.keys()] });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Record<string, ExpoTicket> };
    for (const [id, receipt] of Object.entries(body.data ?? {})) {
      const token = receiptTokens.get(id);
      if (token && receipt.details?.error === 'DeviceNotRegistered') {
        this.opts.onDeviceNotRegistered(token);
      }
    }
  }

  private async post(url: string, payload: unknown): Promise<Response> {
    const token = await this.opts.accessToken();
    return this.fetchFn(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  }
}
