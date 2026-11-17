import type { EthosConfig } from '@ethosagent/config';
import type { CallCaptureDependencyCheckResult } from '@ethosagent/platform-callcapture';
import { type LiveKitMediaResolution, resolveLiveKitMedia } from '../livekit-media';
import { c } from './doctor-shared';

export interface CallCaptureDaemonHealthResult {
  status: 'ok' | 'stale' | 'down';
  lastHeartbeatAgeSec: number | null;
}

export interface CallCaptureCheckResult {
  /** Whether `callCapture.personalityId` is set at all — an unconfigured
   *  deployment reports nothing further, same "don't warn about an unused
   *  feature" rule the Channel SDKs section follows. */
  configured: boolean;
  ok: boolean;
  missing: string[];
  errors: string[];
  /** Daemon liveness (see `checkCallCaptureDaemonHealth`) — present only
   *  when `configured` is true. Absent, not a placeholder value, when
   *  unconfigured: a deployment that never enabled call capture must see
   *  nothing new from `ethos doctor`. */
  daemon?: CallCaptureDaemonHealthResult;
}

export interface CheckCallCaptureOptions {
  /** Overrides the dependency preflight call. Tests must supply this — a
   *  fake — instead of exercising the real capture-offer-card/native-binary
   *  presence on the machine running the test suite. Mirrors
   *  `telephonyReport`'s injectable `resolveMedia` option. */
  checkDependencies?: () => Promise<CallCaptureDependencyCheckResult>;
}

/**
 * Telephony rows — everything an operator needs to know BEFORE they dial.
 *
 * This replaced a single line ("N voice bot(s); LiveKit configured; SIP trunk
 * configured") that answered none of the questions a person actually has when a
 * call does not work: is the webhook listener even running, is the control plane
 * constructible, did the media SDK load, who gets through, and which number
 * reaches which personality. Each of those has its own failure and its own fix,
 * so each gets its own row.
 *
 * Two rules, both load-bearing:
 *
 *   - NOTHING here changes doctor's exit code. `computeDoctorExit` takes
 *     `DoctorFailFlags`, which has no telephony member and gains none — a
 *     deployment that does not do telephony is not unhealthy, and one that does
 *     is not unhealthy for lacking an optional native package.
 *   - An unrun probe reports SKIPPED, never passed (the `listen doctor` rule).
 *     The only thing actually exercised here is the media import; the control
 *     plane and the gates are reported as CONFIGURED, which is a different and
 *     weaker claim than "verified".
 */
export async function telephonyReport(
  voice: NonNullable<EthosConfig['voice']>,
  deps: { resolveMedia?: () => Promise<LiveKitMediaResolution> } = {},
): Promise<string[]> {
  const lines: string[] = [];
  const trunk = voice.trunk;
  const livekit = voice.livekit;

  // --- Trunk -------------------------------------------------------------
  if (!trunk) {
    lines.push(`  ${c.dim}–  SIP trunk not configured (no voice.trunk.*).${c.reset}`);
  } else {
    lines.push(
      `  ${c.green}✓${c.reset}  SIP trunk ${c.cyan}${trunk.provider}${c.reset} ${c.dim}(trunkId ${trunk.trunkId}${trunk.fromNumber ? `, from ${trunk.fromNumber}` : ''})${c.reset}`,
    );
    lines.push(
      trunk.webhookSecret
        ? `  ${c.green}✓${c.reset}  Inbound webhook secret set ${c.dim}(listener mounts at ${trunk.webhookPath ?? '/sip/inbound'})${c.reset}`
        : `  ${c.yellow}⚠${c.reset}  ${c.dim}voice.trunk.webhookSecret is unset — the inbound call listener stays off. An unsigned webhook is an open line anyone who learns the URL can ring.${c.reset}`,
    );
  }

  // --- LiveKit control plane ---------------------------------------------
  // Signed JWT + HTTPS, no SDK: present credentials mean the SIP trunk client
  // and the token minter are CONSTRUCTIBLE. Not that the server answered —
  // nothing here dials it.
  if (!livekit) {
    lines.push(
      trunk
        ? `  ${c.red}✗${c.reset}  LiveKit control plane absent ${c.dim}(voice.livekit.url/apiKey/apiSecret) — a trunk without it has no SIP control plane; telephony is unavailable.${c.reset}`
        : `  ${c.dim}–  LiveKit control plane not configured (no voice.livekit.*).${c.reset}`,
    );
  } else {
    lines.push(
      `  ${c.green}✓${c.reset}  LiveKit control plane ${c.dim}(${livekit.url}; token minter + SIP trunk client constructible — not dialled from here)${c.reset}`,
    );
  }

  // --- LiveKit media ------------------------------------------------------
  // The one thing this report actually runs. `@livekit/rtc-node` is not a repo
  // dependency (per-arch native binary), so an operator installs it themselves;
  // without it every other row can be green and a call still carries no audio.
  const resolveMedia = deps.resolveMedia ?? (() => resolveLiveKitMedia());
  const media = await resolveMedia();
  if (media.ok) {
    lines.push(
      `  ${c.green}✓${c.reset}  LiveKit media ${c.cyan}@livekit/rtc-node${media.version ? ` ${media.version}` : ''}${c.reset} ${c.dim}(calls can carry audio)${c.reset}`,
    );
  } else if (trunk || livekit) {
    lines.push(
      `  ${c.yellow}⚠${c.reset}  LiveKit media unavailable: ${c.dim}${media.reason}${c.reset}`,
    );
    lines.push(
      `  ${c.dim}   Calls are answered, screened and logged, but carry no audio until it loads.${c.reset}`,
    );
  } else {
    lines.push(`  ${c.dim}–  LiveKit media not needed (no trunk, no LiveKit).${c.reset}`);
  }

  // --- Inbound gates ------------------------------------------------------
  const inbound = voice.inbound;
  lines.push(
    `  ${c.dim}   Inbound gates: concurrency ${inbound?.concurrencyCap ?? '2 (default)'}` +
      `; per-caller/hour ${inbound?.perCallerPerHour ?? 'unlimited'}` +
      `; daily budget ${inbound?.dailyBudgetUsd !== undefined ? `$${inbound.dailyBudgetUsd}` : 'unlimited'}` +
      `; prewarm ${inbound?.prewarm ?? 'allowlisted (default)'}${c.reset}`,
  );
  lines.push(
    `  ${c.dim}   Allowlist ${inbound?.allowlist?.length ?? 0} pattern(s)` +
      `; receptionist ${inbound?.receptionist ?? 'not configured'}` +
      `; owner ${inbound?.owner ? `${inbound.owner.platform}:${inbound.owner.chatId}` : 'not configured — call summaries have nowhere to go'}${c.reset}`,
  );

  // --- Number → bot → personality ----------------------------------------
  if (voice.bots.length === 0) {
    lines.push(
      `  ${c.dim}–  No voice bots configured — no number maps to a personality (voice.bots[]).${c.reset}`,
    );
  } else {
    for (const bot of voice.bots) {
      const key = bot.id ?? `sha256(${bot.match})`;
      lines.push(
        `  ${c.dim}   ${bot.match} → ${key} → ${bot.bind.type} ${bot.bind.name}${c.reset}`,
      );
    }
  }

  return lines;
}
