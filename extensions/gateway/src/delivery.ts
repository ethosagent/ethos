import type { DeliveryKind, DeliveryLedger } from '@ethosagent/delivery-ledger';

// ---------------------------------------------------------------------------
// Two-phase delivery-obligation wrapper (item 9)
//
// Shared by the Gateway's own reply paths and by `DraftStreamer`'s terminal
// edit, so the "record before, confirm after, and NEVER let the ledger break a
// reply" policy lives in exactly one place.
//
// A ledger failure must never cost the user their message: both helpers
// swallow their own errors and report them through `onLedgerError`. Failing to
// record degrades to today's behavior (no durability); failing to confirm
// leaves the row `pending`, so the worst case is a redundant redelivery — the
// same at-least-once trade the ledger already makes.
// ---------------------------------------------------------------------------

/** A ledger plus the identity bits one outbound surface contributes. */
export interface DeliveryBinding {
  ledger: DeliveryLedger;
  botKey: string;
  platform: string;
  /**
   * The inbound-spool row whose turn this reply answers. Stamped on every
   * obligation recorded through the binding so a replayed turn can ask the
   * ledger whether its reply already exists (`DeliveryLedger.hasObligationFor`).
   */
  inboundRef?: string;
  /** Observability seam for ledger-internal failures. Never rethrown. */
  onLedgerError?: (stage: 'record' | 'confirm', error: string) => void;
}

/**
 * Obligations whose live platform send is still running in THIS process, per
 * ledger instance. `beginDelivery` adds the id, `endDelivery` removes it, and
 * the gateway's sweep skips every id listed here (`isDeliveryInFlight`), so a
 * send that outlasts the sweep's age grace — a flood-wait backoff, a large
 * voice upload — is not redelivered while the original is still going out.
 * Keyed by ledger rather than held on the Gateway so every writer sharing the
 * gateway's ledger — the webhook relay included — is covered without plumbing.
 * In-process only: a PEER process sharing the ledger file cannot see it.
 */
const inFlight = new WeakMap<DeliveryLedger, Set<string>>();

/** Whether `obligationId`'s live send is still in progress in this process. */
export function isDeliveryInFlight(ledger: DeliveryLedger, obligationId: string): boolean {
  return inFlight.get(ledger)?.has(obligationId) ?? false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write the `pending` obligation. Returns its id, or `null` when there is no
 * ledger, nothing to deliver, or the write itself failed.
 */
export async function beginDelivery(
  binding: DeliveryBinding | undefined,
  input: {
    chatId: string;
    sessionId: string;
    threadId?: string | undefined;
    content: string;
    /** Defaults to `'text'`. `'voice'` rows redeliver bytes, not a string. */
    kind?: DeliveryKind;
    /** Artifact key for a `voice` row — what redelivery re-sends. */
    artifactRef?: string | undefined;
    /** The `VoiceAudioFormat` the artifact holds. */
    mediaFormat?: string | undefined;
  },
): Promise<string | null> {
  if (!binding || !input.content) return null;
  let id: string;
  try {
    id = await binding.ledger.record({
      botKey: binding.botKey,
      platform: binding.platform,
      chatId: input.chatId,
      sessionId: input.sessionId,
      // A thread is part of WHERE the reply belongs, not decoration: the lane
      // key already encodes it. Dropping it here would redeliver into the root
      // chat, out of the context that made the answer legible.
      threadId: input.threadId,
      content: input.content,
      // For a voice row `content` is the SPOKEN TEXT, so the row still hashes
      // to a dedup-comparable value and stays diagnosable when its artifact is
      // gone. These three carry everything the sweep needs to re-send bytes.
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
      ...(input.mediaFormat ? { mediaFormat: input.mediaFormat } : {}),
      ...(binding.inboundRef ? { inboundRef: binding.inboundRef } : {}),
    });
  } catch (err) {
    binding.onLedgerError?.('record', errMsg(err));
    return null;
  }
  let ids = inFlight.get(binding.ledger);
  if (!ids) {
    ids = new Set();
    inFlight.set(binding.ledger, ids);
  }
  ids.add(id);
  return id;
}

/**
 * The live send for `obligationId` is over, confirmed or not. Every caller of
 * {@link beginDelivery} calls this in a `finally` around its platform call —
 * an id left registered is one the sweep would never retry in this process.
 */
export function endDelivery(
  binding: DeliveryBinding | undefined,
  obligationId: string | null,
): void {
  if (!binding || obligationId === null) return;
  inFlight.get(binding.ledger)?.delete(obligationId);
}

/**
 * Mark the obligation delivered. Call ONLY when the platform confirmed
 * (`DeliveryResult.ok === true` / the terminal edit landed) — an unconfirmed
 * send must stay `pending` so the sweep redelivers it. Does not end the
 * in-flight registration; {@link endDelivery} does, on every outcome.
 */
export async function confirmDelivery(
  binding: DeliveryBinding | undefined,
  obligationId: string | null,
): Promise<void> {
  if (!binding || obligationId === null) return;
  try {
    await binding.ledger.markDelivered(obligationId);
  } catch (err) {
    binding.onLedgerError?.('confirm', errMsg(err));
  }
}
