import type { CliSubcommandContext, SlashCommandContext } from '@ethosagent/types';
import type { HostLease } from '../pool';
import type { CliRegistration, SlashRegistration } from '../protocol';

/** A command may legitimately run long; the host's own limits (abort, ping) still apply. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * A slash command whose handler runs in the host. `send` is a reverse
 * notification, `storage` is the call-scoped handle, and `toolRegistry` is
 * absent (live object identity, plan §4.2).
 */
export function createSlashHandler(
  reg: SlashRegistration,
  lease: HostLease,
): (args: string, ctx: SlashCommandContext) => Promise<string> {
  return (args, ctx) =>
    lease.withCall(
      {
        ...(ctx.storage ? { storage: ctx.storage } : {}),
        output: {
          send: (text) => ctx.send(text),
          stdout: () => undefined,
          stderr: () => undefined,
          emit: (text) => void ctx.send(text),
        },
      },
      async (call) => {
        const raw = await lease.request(
          'ethos/command.run',
          {
            kind: 'slash',
            name: reg.name,
            call,
            input: {
              args,
              sessionId: ctx.sessionId,
              platform: ctx.platform,
              ...(ctx.personalityId !== undefined ? { personalityId: ctx.personalityId } : {}),
              ...(ctx.sender ? { sender: ctx.sender } : {}),
              hasStorage: ctx.storage !== undefined,
            },
          },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        if (typeof raw !== 'string') {
          throw new Error(
            `Plugin '${lease.pluginId}' command '${reg.name}' returned a malformed result`,
          );
        }
        return raw;
      },
    );
}

export function createCliHandler(
  reg: CliRegistration,
  lease: HostLease,
): (ctx: CliSubcommandContext) => Promise<number> {
  return (ctx) =>
    lease.withCall(
      {
        ...(ctx.storage ? { storage: ctx.storage } : {}),
        output: {
          send: (text) => ctx.stdout(text),
          stdout: (text) => ctx.stdout(text),
          stderr: (text) => ctx.stderr(text),
          emit: (text) => ctx.stdout(text),
        },
      },
      async (call) => {
        const raw = await lease.request(
          'ethos/command.run',
          {
            kind: 'cli',
            name: reg.name,
            call,
            input: { argv: ctx.argv, cwd: ctx.cwd, hasStorage: ctx.storage !== undefined },
          },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        if (typeof raw !== 'number') {
          throw new Error(
            `Plugin '${lease.pluginId}' command '${reg.name}' returned a malformed result`,
          );
        }
        return raw;
      },
    );
}
