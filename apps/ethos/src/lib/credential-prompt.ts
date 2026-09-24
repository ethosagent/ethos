// openclaw-9.5 item 1 — the CLI's masked answer to `credential_required`.
//
// The value is read with echo muted, handed to `PluginLoader.setCredential`
// (D15: the one writer — it validates the key through `credentialRef()` and
// writes through the plugin's own vault), and then dropped. It never reaches
// the session transcript, the model, an `AgentEvent`, readline history, or a
// log line: the caller only learns whether to resubmit the pending message.
// Pinned by `apps/ethos/src/__tests__/credential-prompt.test.ts`.

import type { Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { EventTranslatorCredentialRequired } from '@ethosagent/surface-kit';

/** A readline output that can stop echoing while a secret is typed. */
export interface MutableOutput {
  readonly stream: Writable;
  mute(): void;
  unmute(): void;
}

export function createMutableOutput(target: NodeJS.WritableStream): MutableOutput {
  let muted = false;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) target.write(chunk);
      cb();
    },
  });
  return {
    stream,
    mute: () => {
      muted = true;
    },
    unmute: () => {
      muted = false;
    },
  };
}

/**
 * Ask `question` on `target`, then read ONE line from `rl` with echo muted.
 * The answer is removed from readline's in-memory history, so the up arrow
 * cannot bring it back. The caller must keep its own `line` handler out of the
 * way while this is pending (chat.ts: `state.awaitingSecret`).
 */
export function readMaskedLine(
  rl: Interface,
  output: MutableOutput,
  target: NodeJS.WritableStream,
  question: string,
): Promise<string> {
  target.write(question);
  output.mute();
  return new Promise((resolve) => {
    rl.once('line', (answer: string) => {
      output.unmute();
      target.write('\n');
      // `history` is readline's own array (newest first); it is not part of the
      // typed surface, so reach it structurally.
      const history = (rl as unknown as { history?: string[] }).history;
      if (Array.isArray(history)) {
        const at = history.indexOf(answer);
        if (at !== -1) history.splice(at, 1);
      }
      resolve(answer);
    });
  });
}

export interface CollectCredentialDeps {
  /** Read the value without echo (`readMaskedLine` in production). */
  readSecret: (question: string) => Promise<string>;
  /** Print one user-facing line. Never passed the value. */
  write: (line: string) => void;
  /** `PluginLoader.setCredential` — the one writer (D15). */
  setCredential: (pluginId: string, key: string, value: string) => Promise<void>;
}

/**
 * Prompt for the missing credential and store it. Returns `true` when it was
 * stored and the caller should resubmit `req.pendingUserMessage` as a new turn;
 * `false` when the user left it blank (nothing stored) or the write failed
 * (the error is shown, e.g. `Plugin "<id>" is not loaded`, and nothing is
 * resubmitted).
 */
export async function collectPluginCredential(
  req: Pick<
    EventTranslatorCredentialRequired,
    'pluginId' | 'credentialKey' | 'label' | 'description'
  >,
  deps: CollectCredentialDeps,
): Promise<boolean> {
  deps.write(`Plugin "${req.pluginId}" needs ${req.label} (${req.credentialKey}).`);
  if (req.description) deps.write(req.description);
  const value = await deps.readSecret(`${req.label} (input hidden, empty to skip): `);
  if (value.trim() === '') {
    deps.write('Skipped — nothing was stored. Your next message will ask again.');
    return false;
  }
  try {
    await deps.setCredential(req.pluginId, req.credentialKey, value);
  } catch (err) {
    deps.write(`Could not store it: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  deps.write(`Saved ${req.credentialKey} for ${req.pluginId}. Sending your message again.`);
  return true;
}
