// DiscordClarifySurface — wires a Discord bot to the clarify protocol.
//
//   1. When the agent calls `clarify(...)`, the bridge fires `present()`. The
//      surface posts a Discord message with Button components (or an "Answer"
//      button for free-form), then writes the (channelId, messageId, botKey,
//      originatorUserId?) back into the persisted row so post-restart sweeps
//      and edits can find it.
//   2. Button clicks arrive as `interactionCreate` events; `handleEvent()`
//      validates the stored row's (botKey, channelId, messageId) match and
//      calls `bridge.respond()` (or opens a modal for free-form).
//   3. Modal submissions arrive as `interactionCreate` events of type
//      ModalSubmit; `handleEvent()` reads the answer and resolves.
//   4. On every resolution (answer / timeout / cancel) the bridge notifies
//      `onResolved` and the surface edits the original message in place to
//      its resolved state — components removed.
//
// Mirrors `TelegramClarifySurface` and `SlackClarifySurface`. See
// plan/phases/tool_clarity_plan.md Surface 6.
import {
  clarifyModalPayload,
  clarifyPendingMessage,
  clarifyResolvedMessage,
} from './clarify-blocks';

const SURFACE = 'discord';
export class DiscordClarifySurface {
  adapter;
  bridge;
  store;
  getSessionRouting;
  /** Captures the responding user id between `bridge.respond()` and
   *  `onResolved` so the resolved card credits the answerer. Bounded. */
  responderById = new Map();
  constructor(cfg) {
    this.adapter = cfg.adapter;
    this.bridge = cfg.bridge;
    this.store = cfg.store;
    this.getSessionRouting = cfg.getSessionRouting;
    this.bridge.setPresenter((row) => this.present(row));
    this.bridge.onResolved((row, resp) => {
      void this.onResolved(row, resp);
    });
    this.adapter.onClarifyInteraction((raw) => {
      void this.handleInteraction(raw);
    });
  }
  async present(row) {
    if (row.surfaceType !== SURFACE) return;
    const routing = this.getSessionRouting(row.sessionId);
    if (!routing) return;
    const msg = clarifyPendingMessage({
      requestId: row.requestId,
      question: row.question,
      ...(row.options !== undefined ? { options: row.options } : {}),
      ...(row.default !== undefined ? { default: row.default } : {}),
      defaultDeadlineAt: row.defaultDeadlineAt,
    });
    const result = await this.adapter.postClarifyCard({
      chatId: routing.chatId,
      content: msg.content,
      components: msg.components,
    });
    if ('error' in result) return; // bridge timer cleans up
    await this.store.update(row.requestId, {
      surfaceContext: {
        ...row.surfaceContext,
        chatId: routing.chatId,
        botKey: this.adapter.botKey,
        messageId: result.messageId,
        ...(routing.requesterUserId !== undefined
          ? { originatorUserId: routing.requesterUserId }
          : {}),
      },
    });
  }
  // -------------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------------
  async handleInteraction(raw) {
    const evt = raw.event;
    if (evt.kind === 'modal-submit') {
      // Modals can be submitted from any channel context the user has the
      // modal open in. Validate by botKey + answerer; rely on the opaque
      // requestId for cross-session isolation.
      await this.adapter.ackModalSubmit({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      const row = await this.store.get(evt.requestId);
      if (!row || row.surfaceType !== SURFACE) return;
      if (row.surfaceContext.botKey !== this.adapter.botKey) return;
      if (!gateAnswerer(row, evt.userId)) return;
      this.rememberResponder(row.requestId, evt.userId);
      await this.bridge.respond({
        requestId: row.requestId,
        answer: evt.answer,
        source: 'user',
      });
      return;
    }
    // Button click. Validate the row first, then branch: open-modal goes
    // straight to showModal (the first and only response); choice/cancel
    // acks via deferUpdate and resolves.
    const row = await this.store.get(evt.requestId);
    if (!row || row.surfaceType !== SURFACE) {
      // Row gone or not ours — ack with deferUpdate so Discord doesn't
      // show an error to the user, then bail.
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }
    // Cross-tenant gate: stored (botKey, chatId, messageId) must match the
    // click's origin. Same posture as the Telegram and Slack surfaces.
    if (
      row.surfaceContext.botKey !== this.adapter.botKey ||
      row.surfaceContext.chatId !== evt.channelId ||
      row.surfaceContext.messageId !== evt.messageId
    ) {
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }
    if (!gateAnswerer(row, evt.userId)) {
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }
    if (evt.kind === 'open-modal') {
      // showModal must be the FIRST response — don't call ackButtonClick
      // (which calls deferUpdate and consumes the response window).
      const modal = { requestId: row.requestId, question: row.question };
      await this.adapter.openClarifyModal({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
        modal: clarifyModalPayload(modal),
      });
      return;
    }
    // Choice or cancel — ack (deferUpdate + drain), then resolve.
    await this.adapter.ackButtonClick({
      interactionId: raw.interactionId,
      interactionToken: raw.interactionToken,
    });
    let response;
    if (evt.kind === 'cancel') {
      response = { requestId: row.requestId, answer: '', source: 'cancel' };
    } else {
      const answer = row.options?.[evt.choiceIndex];
      if (answer === undefined) return; // out-of-range / stale
      response = { requestId: row.requestId, answer, source: 'user' };
    }
    this.rememberResponder(row.requestId, evt.userId);
    await this.bridge.respond(response);
  }
  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------
  async onResolved(row, response) {
    if (row.surfaceType !== SURFACE) return;
    if (row.surfaceContext.botKey !== this.adapter.botKey) return;
    const chatId = row.surfaceContext.chatId;
    const messageId = row.surfaceContext.messageId;
    if (typeof chatId !== 'string' || typeof messageId !== 'string') return;
    const answeredBy = this.responderById.get(row.requestId);
    this.responderById.delete(row.requestId);
    const msg = buildResolved(row, response, answeredBy);
    await this.adapter.updateClarifyCard({
      chatId,
      messageId,
      content: msg.content,
      components: msg.components,
    });
  }
  rememberResponder(requestId, userId) {
    if (this.responderById.size >= 1024) {
      const first = this.responderById.keys().next().value;
      if (first !== undefined) this.responderById.delete(first);
    }
    this.responderById.set(requestId, userId);
  }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function gateAnswerer(row, userId) {
  if (row.answerableBy === 'anyone') return true;
  const originator = row.surfaceContext.originatorUserId;
  if (typeof originator !== 'string') return false;
  return userId === originator;
}
function buildResolved(row, response, answeredBy) {
  if (!response) {
    return clarifyResolvedMessage({
      question: row.question,
      answer: '',
      source: 'timeout-no-default',
    });
  }
  return clarifyResolvedMessage({
    question: row.question,
    answer: response.answer,
    source: response.source,
    ...(answeredBy !== undefined && response.source === 'user' ? { answeredBy } : {}),
  });
}
