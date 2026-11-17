import {
  resolveSttProviderForPersonality,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  type SttProviderForPersonality,
  selectSttEntry,
  selectTtsEntry,
  type TtsProviderForPersonality,
} from '@ethosagent/core';
import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type {
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  Storage,
  SttProvider,
  SttProviderEntry,
  SttProviderRegistry,
  TtsProvider,
  TtsProviderEntry,
  TtsProviderRegistry,
  VoiceAudioFormat,
} from '@ethosagent/types';
import { isVoiceOutboundAdapter, voiceAudioExtension, voiceAudioMimeType } from '@ethosagent/types';
import { sanitizeForSpeech, truncateAtSentenceBoundary } from '@ethosagent/voice-text';
import { beginDelivery, confirmDelivery, type DeliveryBinding, endDelivery } from './delivery';
import type { GatewayBotConfig, GatewayConfig, GatewayObservability } from './gateway-config';
import { DEFAULT_VOICE_ENTRY_KEY, noopLogger, VOICE_FAILURE_NOTICE } from './gateway-pure';
import type { TranscodeResult, Transcoder } from './transcode';
import type { VoiceArtifactStore } from './voice-artifacts';
import { buildTranscriptText, transcribeAudioAttachments } from './voice-pipeline';

/** What `VoiceReply` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface VoiceReplyDeps {
  readonly bots: Map<string, GatewayBotConfig>;
  readonly channelVoiceOut: Readonly<Record<string, boolean>> | undefined;
  deliveryBinding(
    botKey: string,
    platform: string,
    inboundRef?: string,
  ): DeliveryBinding | undefined;
  readonly deliveryLedger: DeliveryLedger | undefined;
  readonly observability: GatewayObservability | undefined;
  pauseOffsetMs: number;
  readonly personalityDirectory: GatewayConfig['personalityDirectory'];
  readonly sttProviderConfig: Record<string, unknown>;
  readonly sttProviderName: string | undefined;
  readonly sttProviderRegistry: SttProviderRegistry | undefined;
  readonly sttProviderRoster: Readonly<Record<string, SttProviderEntry>> | undefined;
  readonly sttProviders: Map<string, Promise<SttProviderForPersonality>>;
  readonly transcoder: Transcoder | undefined;
  readonly trustedVoicePlugins: ReadonlySet<string> | undefined;
  readonly ttsProviderConfig: Record<string, unknown>;
  readonly ttsProviderName: string | undefined;
  readonly ttsProviderRegistry: TtsProviderRegistry | undefined;
  readonly ttsProviderRoster: Readonly<Record<string, TtsProviderEntry>> | undefined;
  readonly ttsProviders: Map<string, Promise<TtsProviderForPersonality>>;
  readonly voiceArtifacts: VoiceArtifactStore | undefined;
  readonly voiceBitrateKbps: number | undefined;
  readonly voiceProviderErrors: { stt?: string; tts?: string };
  readonly voiceSecretsResolver: import('@ethosagent/types').SecretsResolver | undefined;
  readonly voiceTranscripts: WeakMap<
    InboundMessage,
    Map<string, Promise<{ text: string; providerId: string | undefined }>>
  >;
}

export class VoiceReply {
  constructor(private readonly deps: VoiceReplyDeps) {}

  // Both resolvers delegate to the SHARED resolution path in
  // `@ethosagent/core` — the same one web-api and the wiring-built
  // VoiceSession stack use. Nothing here re-implements provider lookup, roster
  // selection or the local-only egress gate; a second implementation is exactly
  // how "config says one provider, the pipeline used another" happens, and the
  // gate lives INSIDE that shared resolver so there is one door, not two.
  //
  // Resolution is per-PERSONALITY. The memo key is the selected roster entry,
  // computed by the pure `select*Entry` BEFORE the async factory call — so an
  // unknown roster name collapses onto the default entry's cached provider,
  // which is where the shared resolver would send it anyway. The returned
  // `providerId` is what the caller stamps into its telemetry, so "which
  // provider served this reply" stays answerable per turn rather than per boot.
  resolveSttFor(
    personalityVoice: PersonalityVoiceConfig | undefined,
  ): Promise<SttProviderForPersonality> {
    const key =
      selectSttEntry({
        ...(personalityVoice?.stt_provider ? { requestedName: personalityVoice.stt_provider } : {}),
        ...(this.deps.sttProviderRoster ? { roster: this.deps.sttProviderRoster } : {}),
      }).entryName ?? DEFAULT_VOICE_ENTRY_KEY;
    const cached = this.deps.sttProviders.get(key);
    if (cached) return cached;
    const pending = resolveSttProviderForPersonality({
      registry: this.deps.sttProviderRegistry,
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(this.deps.sttProviderRoster ? { roster: this.deps.sttProviderRoster } : {}),
      ...(this.deps.sttProviderName ? { defaultProviderName: this.deps.sttProviderName } : {}),
      defaultProviderConfig: this.deps.sttProviderConfig,
      ...(this.deps.voiceSecretsResolver ? { secrets: this.deps.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.deps.trustedVoicePlugins
        ? { trustedVoicePlugins: this.deps.trustedVoicePlugins }
        : {}),
    });
    this.deps.sttProviders.set(key, pending);
    return pending;
  }

  resolveTtsFor(
    personalityVoice: PersonalityVoiceConfig | undefined,
  ): Promise<TtsProviderForPersonality> {
    const key =
      selectTtsEntry({
        ...(personalityVoice?.tts_provider ? { requestedName: personalityVoice.tts_provider } : {}),
        ...(this.deps.ttsProviderRoster ? { roster: this.deps.ttsProviderRoster } : {}),
      }).entryName ?? DEFAULT_VOICE_ENTRY_KEY;
    const cached = this.deps.ttsProviders.get(key);
    if (cached) return cached;
    const pending = resolveTtsProviderForPersonality({
      registry: this.deps.ttsProviderRegistry,
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(this.deps.ttsProviderRoster ? { roster: this.deps.ttsProviderRoster } : {}),
      ...(this.deps.ttsProviderName ? { defaultProviderName: this.deps.ttsProviderName } : {}),
      defaultProviderConfig: this.deps.ttsProviderConfig,
      ...(this.deps.voiceSecretsResolver ? { secrets: this.deps.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.deps.trustedVoicePlugins
        ? { trustedVoicePlugins: this.deps.trustedVoicePlugins }
        : {}),
    });
    this.deps.ttsProviders.set(key, pending);
    return pending;
  }

  /**
   * The STT provider serving one personality's inbound audio, or null when none
   * resolved. Records the failure reason (unless "not configured", which is not
   * a failure) so a refused provider is reportable rather than looking like
   * "voice just doesn't work here".
   */
  async resolveSttProvider(personalityId?: string): Promise<{
    provider: SttProvider | null;
    providerId: string | undefined;
  }> {
    const { resolution } = await this.resolveSttFor(this.personalityVoice(personalityId));
    if (resolution.ok) {
      return { provider: resolution.provider, providerId: resolution.providerId };
    }
    if (resolution.code !== 'not_configured') this.deps.voiceProviderErrors.stt = resolution.error;
    return { provider: null, providerId: undefined };
  }

  /** The TTS provider serving one personality's replies. Mirrors the STT half. */
  async resolveTtsProvider(personalityId?: string): Promise<{
    provider: TtsProvider | null;
    providerId: string | undefined;
    /** The chosen entry's own voice id — the lowest rung of voice precedence. */
    entryVoice: string | undefined;
  }> {
    const { resolution, globalTtsVoice } = await this.resolveTtsFor(
      this.personalityVoice(personalityId),
    );
    if (resolution.ok) {
      return {
        provider: resolution.provider,
        providerId: resolution.providerId,
        entryVoice: globalTtsVoice,
      };
    }
    if (resolution.code !== 'not_configured') this.deps.voiceProviderErrors.tts = resolution.error;
    return { provider: null, providerId: undefined, entryVoice: undefined };
  }

  /** This personality's `voice` block, when the directory seam exposes one. */
  personalityVoice(personalityId?: string): PersonalityVoiceConfig | undefined {
    return personalityId ? this.deps.personalityDirectory?.voice?.(personalityId) : undefined;
  }

  /**
   * What voice resolution actually does here: the provider ids that serve this
   * gateway's DEFAULT entries, plus the reason either one is missing (unknown
   * provider, failed init, or refused by the local-only egress gate). Resolution
   * is memoized, so calling this is equivalent to what the first voice message
   * on a personality with no roster pick triggers — which is exactly why it can
   * answer "which provider ran".
   */
  async voiceProviderStatus(): Promise<{
    stt: string | undefined;
    tts: string | undefined;
    sttError: string | undefined;
    ttsError: string | undefined;
  }> {
    const stt = await this.resolveSttProvider();
    const tts = await this.resolveTtsProvider();
    return {
      stt: stt.providerId,
      tts: tts.providerId,
      sttError: this.deps.voiceProviderErrors.stt,
      ttsError: this.deps.voiceProviderErrors.tts,
    };
  }

  /**
   * The STT half of the voice pipeline: `text` with the transcript of every
   * audio attachment on `message` folded in (`buildTranscriptText`). Resolved
   * for THIS personality: a personality naming `voice.stt_provider` is
   * transcribed by that provider on a channel voice note, not only in browser
   * talk mode. Shared by `runTurn` and a mid-turn steer (`steerEntryFor`), so
   * a voice note is transcribed the same way on both — and only once: the
   * result is kept per message and text (`voiceTranscripts`, V-GC-4).
   */
  async transcribeVoiceNote(
    message: InboundMessage,
    text: string,
    personalityId: string | undefined,
    io: { attachmentCache: AttachmentCache; storage: Storage },
  ): Promise<{ text: string; providerId: string | undefined }> {
    const byText = this.deps.voiceTranscripts.get(message) ?? new Map();
    this.deps.voiceTranscripts.set(message, byText);
    const cached = byText.get(text);
    if (cached) return cached;
    const pending = this.transcribeVoiceNoteOnce(message, text, personalityId, io);
    byText.set(text, pending);
    // A failed transcription is not remembered: the next caller tries again.
    pending.catch(() => byText.delete(text));
    return pending;
  }

  async transcribeVoiceNoteOnce(
    message: InboundMessage,
    text: string,
    personalityId: string | undefined,
    io: { attachmentCache: AttachmentCache; storage: Storage },
  ): Promise<{ text: string; providerId: string | undefined }> {
    const stt = await this.resolveSttProvider(personalityId);
    const results = await transcribeAudioAttachments(
      message.attachments ?? [],
      stt.provider,
      (url) => io.storage.readBytes(io.attachmentCache.resolveLocalPath(url)),
      {
        // Normalize before STT and retry once as wav. Absent transcoder →
        // the provider gets the platform's raw bytes, as it always did.
        ...(this.deps.transcoder ? { transcoder: this.deps.transcoder } : {}),
        onStage: (event) => {
          if (event.ok) return;
          this.deps.observability?.recordSafetyBlock({
            code: `gateway.voice_stt_${event.stage}_failed`,
            cause: event.error,
            details: { platform: message.platform, chatId: message.chatId },
          });
        },
      },
    );
    return { text: buildTranscriptText(text, results), providerId: stt.providerId };
  }

  // ---------------------------------------------------------------------------
  // Voice replies (voice V2)
  // ---------------------------------------------------------------------------

  /**
   * Speak one already-delivered reply.
   *
   * The caller has already asked `shouldReplyWithVoice()` — that decision has
   * exactly one implementation and does not live here. What lives here is
   * everything between "yes, speak" and bytes on the platform: caps, synthesis,
   * transcode, the byte cap, the artifact, and the delivery obligation.
   *
   * ONE voice note per reply, whatever its length. Sentence-chunking belongs to
   * live surfaces, where a listener is waiting on the first sentence; on a
   * channel it is eight notifications for one answer.
   *
   * Every early return records an event. A voice reply that silently does not
   * arrive is the failure mode this whole lane exists to close, so "nothing
   * happened and nobody knows why" is not an acceptable outcome of any branch.
   */
  async deliverVoiceReply(input: {
    adapter: PlatformAdapter;
    botKey: string;
    platform: string;
    chatId: string;
    threadId: string | undefined;
    sessionKey: string;
    text: string;
    personalityId: string | undefined;
    language: string | undefined;
  }): Promise<void> {
    // `recordSafetyBlock` is this file's generic event sink — `dedup_drop` and
    // `delivery_redelivered` already ride it — not a claim that a skipped voice
    // note is a safety violation.
    const event = (code: string, details: Record<string, unknown> = {}, cause?: string): void => {
      this.deps.observability?.recordSafetyBlock({
        code,
        ...(cause ? { cause } : {}),
        details: {
          platform: input.platform,
          botKey: input.botKey,
          chatId: input.chatId,
          ...details,
        },
      });
    };

    // H5 — the lane asked for a voice reply and is not getting one: say so,
    // once, AFTER the text reply (this method only runs once the text is
    // delivered). Untracked, like an ack — the reply itself already went out
    // on the tracked path. Only for PRODUCTION failures (no provider, synth,
    // transcode, format, byte cap): an operator's `ttsOut: false` and an
    // adapter with no voice caps are policy, not failure, and a send the
    // platform refused synthesized fine — its artifact is owed by the ledger
    // sweep, so "couldn't produce audio" would be false there.
    let voiceFailureNoticed = false;
    const noticeVoiceFailure = (): void => {
      if (voiceFailureNoticed) return;
      voiceFailureNoticed = true;
      void input.adapter
        .send(input.chatId, {
          text: VOICE_FAILURE_NOTICE,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        })
        .catch(() => {});
    };

    // 1. Operator override. `voice.channels.<platform>.ttsOut: false` outranks
    //    the lane's mode — a deployment decision beats a conversational one.
    if (this.deps.channelVoiceOut?.[input.platform] === false) {
      event('gateway.voice_channel_disabled');
      return;
    }

    // 2. DECLARED caps, not `'sendVoice' in adapter`. The duck-type could not
    //    tell a voice bubble from a file attachment, could not name an accepted
    //    container, and gave every new adapter a silent no-op by default.
    if (!isVoiceOutboundAdapter(input.adapter)) {
      event('gateway.voice_no_caps');
      return;
    }
    const sink = input.adapter;

    // 3. Provider — resolved for THIS personality. A personality naming
    //    `voice.tts_provider` speaks through that provider on a channel reply,
    //    not only in browser talk mode. The refusal path is unchanged: a
    //    roster entry the egress gate rejects yields no provider and no
    //    synthesize call, whatever the entry was labelled.
    const tts = await this.resolveTtsProvider(input.personalityId);
    const speech = tts.provider;
    if (!speech) {
      event(
        'gateway.voice_no_provider',
        this.deps.voiceProviderErrors.tts ? { error: this.deps.voiceProviderErrors.tts } : {},
      );
      noticeVoiceFailure();
      return;
    }

    // 4. Speakable text — markdown, emoji and code fences are not speech.
    let synthText = sanitizeForSpeech(input.text);
    const maxChars = speech.caps.maxInputChars;
    if (maxChars && synthText.length > maxChars) {
      synthText = truncateAtSentenceBoundary(synthText, maxChars);
    }
    if (synthText.length === 0) return;

    // 5. Which voice. Same resolution function the VoiceSession stack uses, so
    //    "which voice served this reply" has one answer across surfaces:
    //    language-specific > personality default > the CHOSEN entry's own voice
    //    (which is `auxiliary.tts.voice` when the default entry served).
    const personalityVoice = this.personalityVoice(input.personalityId);
    const voicePrefs = resolveVoicePreferences({
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(tts.entryVoice ? { globalTtsVoice: tts.entryVoice } : {}),
      ...(input.language ? { language: input.language } : {}),
    });

    // 6. Synthesis.
    const synthStarted = Date.now();
    let synthesized: Awaited<ReturnType<TtsProvider['synthesize']>>;
    try {
      synthesized = await speech.synthesize(
        synthText,
        voicePrefs.ttsVoice ? { voice: voicePrefs.ttsVoice } : undefined,
      );
    } catch (err) {
      event('gateway.voice_synth_failed', {}, err instanceof Error ? err.message : String(err));
      noticeVoiceFailure();
      return;
    }
    event('gateway.voice_synth', {
      format: synthesized.format,
      bytes: synthesized.audio.length,
      durationMs: Date.now() - synthStarted,
      // The id that actually ran this turn, not a remembered global.
      ...(tts.providerId ? { ttsProvider: tts.providerId } : {}),
      ...(voicePrefs.ttsVoice ? { voice: voicePrefs.ttsVoice } : {}),
    });

    // 7. Transcode into a container the sink actually declared.
    const targets = sink.voiceCaps.outbound.formats;
    let bytes = synthesized.audio;
    let finalFormat: VoiceAudioFormat = synthesized.format;
    if (this.deps.transcoder) {
      // `Transcoder` promises a typed result, but the shipped ffmpeg one writes
      // a scratch file first — a full or read-only tmpdir throws before any of
      // its own error handling runs. The text reply has already gone out, so
      // that must degrade to "no voice note, and here is why", never to a
      // rejected turn.
      const transcoded = await this.deps.transcoder
        .transcode({
          data: synthesized.audio,
          sourceMimeType: voiceAudioMimeType(synthesized.format),
          targets,
          ...(this.deps.voiceBitrateKbps ? { bitrateKbps: this.deps.voiceBitrateKbps } : {}),
        })
        .catch(
          (err: unknown): TranscodeResult => ({
            ok: false,
            code: 'failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      if (!transcoded.ok) {
        event('gateway.voice_transcode_failed', { code: transcoded.code }, transcoded.error);
        noticeVoiceFailure();
        return;
      }
      bytes = transcoded.data;
      finalFormat = transcoded.format;
    } else if (!targets.includes(synthesized.format)) {
      // No ffmpeg on this host. Sending mp3 bytes to a sink that declared opus
      // produces an undownloadable document, not a voice note — so skip and say
      // so, rather than deliver something that looks like a bug to the user.
      event('gateway.voice_format_unsupported', { format: synthesized.format, accepted: targets });
      noticeVoiceFailure();
      return;
    }

    // 8. Platform byte cap.
    const maxBytes = sink.voiceCaps.outbound.maxBytes;
    if (maxBytes !== undefined && bytes.length > maxBytes) {
      event('gateway.voice_too_large', { bytes: bytes.length, maxBytes });
      noticeVoiceFailure();
      return;
    }

    // 9. Persist the artifact BEFORE the send, so a failed send has something
    //    to redeliver. A store that is absent or failing returns null: the
    //    obligation is still recorded, which makes the loss visible even though
    //    it cannot then be repaired.
    const ref = (await this.deps.voiceArtifacts?.put(bytes, finalFormat)) ?? null;

    // 10. Ledger, four-path contract: pending BEFORE the platform call.
    //     `content` is the SPOKEN TEXT — a voice row stays readable, hashes to
    //     a comparable value, and is diagnosable when its artifact is gone.
    const binding = this.deps.deliveryBinding(input.botKey, input.platform);
    const obligationId = await beginDelivery(binding, {
      chatId: input.chatId,
      sessionId: input.sessionKey,
      threadId: input.threadId,
      content: synthText,
      kind: 'voice',
      ...(ref ? { artifactRef: ref } : {}),
      mediaFormat: finalFormat,
    });

    // 11. Send. A throw folds into `{ ok: false }` exactly as in `sendTracked`.
    //     A large upload can outlast the sweep's age grace; the obligation stays
    //     registered in flight (`endDelivery`) until the send settles.
    let result: DeliveryResult;
    try {
      result = await sink
        .sendVoiceNote(input.chatId, bytes, {
          format: finalFormat,
          mimeType: voiceAudioMimeType(finalFormat),
          filename: `reply.${voiceAudioExtension(finalFormat)}`,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        })
        .catch(
          (err: unknown): DeliveryResult => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

      // 12. Confirmed → the obligation is discharged and its artifact is released
      //     (retention D9: delivering deletes). Otherwise the row stays `pending`
      //     and the artifact stays on disk for the sweep to re-send.
      if (result?.ok === true) {
        await confirmDelivery(binding, obligationId);
        if (ref) await this.deps.voiceArtifacts?.remove(ref);
        return;
      }
    } finally {
      endDelivery(binding, obligationId);
    }
    event(
      'gateway.delivery_unconfirmed',
      { kind: 'voice', error: result?.error, durable: obligationId !== null },
      'adapter did not confirm voice delivery',
    );
  }

  /**
   * Discount a host pause from the stale-obligation abandon window.
   *
   * On a snapshot-and-restore host the wall clock advances while the guest is
   * frozen. If the pause alone exceeds `abandonAfterDays`, the first
   * post-resume sweep abandons — and, for voice, DELETES the audio artifact of
   * — an obligation that was never actually lost. Successive pauses accumulate
   * until spent. Non-positive or non-finite durations are a no-op.
   *
   * SPENT ON THE FIRST SWEEP, NOT HELD FOREVER. The offset widens the abandon
   * window for the sweep that follows the resume and is then zeroed. Holding it
   * permanently would apply it to obligations CREATED AFTER the resume, whose
   * `created_at` was stamped by an already-correct clock: a seven-day pause
   * would silently grant every future obligation seven extra retention days,
   * and repeated pauses would compound that without bound until nothing was
   * ever abandoned. Plan §2's own wording for this gate is "the first
   * post-resume sweep"; one-shot is what makes it match the self-limiting
   * bump-forward the other gates use, where the correction lands on the stored
   * timestamps of rows that already exist and cannot touch later ones.
   */
  applyPauseOffset(pauseDurationMs: number): void {
    if (!Number.isFinite(pauseDurationMs) || pauseDurationMs <= 0) return;
    this.deps.pauseOffsetMs += pauseDurationMs;
  }

  /**
   * Retention pass for synthesized voice artifacts.
   *
   * Three mechanisms, in the order they should fire: an obligation that was
   * DELIVERED released its artifact at confirm time (in `deliverVoiceReply`);
   * one that was never delivered is abandoned here after `abandonAfterDays` and
   * its artifact deleted with it; and the total-size cap is the backstop for
   * everything neither of those caught — an artifact whose row vanished, or a
   * burst that outran the abandon window.
   *
   * Never throws, and never runs without both a ledger and a store: abandoning
   * rows whose artifacts nothing can delete, or deleting artifacts whose rows
   * nothing abandoned, would leave the two halves permanently out of step.
   */
  async pruneVoiceArtifacts(opts: {
    abandonAfterDays: number;
    maxTotalMb: number;
  }): Promise<{ abandoned: number; bytesFreed: number }> {
    const ledger = this.deps.deliveryLedger;
    const artifacts = this.deps.voiceArtifacts;
    if (!ledger || !artifacts) return { abandoned: 0, bytesFreed: 0 };

    let abandoned = 0;
    try {
      // Read and SPEND in one step — see `applyPauseOffset`. Zeroed before the
      // await, not after, so a sweep that throws still consumes it: a retained
      // offset would re-widen every later sweep for the life of the process.
      const cutoff = Date.now() - opts.abandonAfterDays * 86_400_000 - this.deps.pauseOffsetMs;
      this.deps.pauseOffsetMs = 0;
      // Ownership-filtered inside the ledger: a shared ledger file must never
      // let this deployment abandon a live peer's obligation.
      const rows = await ledger.abandonStale([...this.deps.bots.keys()], cutoff);
      abandoned = rows.length;
      for (const row of rows) {
        if (row.artifactRef) await artifacts.remove(row.artifactRef);
      }
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.voice_abandon_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    let bytesFreed = 0;
    try {
      bytesFreed = await artifacts.enforceSizeCap(opts.maxTotalMb * 1024 * 1024);
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.voice_size_cap_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return { abandoned, bytesFreed };
  }
}
