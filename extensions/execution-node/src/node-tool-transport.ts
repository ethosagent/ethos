import type { ToolExecuteRequest, ToolResult, ToolTransport } from '@ethosagent/types';
import type { NodeHub } from './node-hub';

/**
 * ToolTransport that sends one call to a connected laptop node (plan D7: the contract is
 * unchanged). One instance per proxy call: the `node` arg and the progress sink are per call.
 */
export class NodeToolTransport implements ToolTransport {
  constructor(
    private readonly hub: NodeHub,
    private readonly opts: {
      node?: string;
      timeoutMs: number;
      onProgress?: (message: string) => void;
    },
  ) {}

  async execute(request: ToolExecuteRequest, signal: AbortSignal): Promise<ToolResult> {
    const pickOpts: { personalityId?: string; node?: string } = {};
    if (request.personalityId !== undefined) pickOpts.personalityId = request.personalityId;
    if (this.opts.node !== undefined) pickOpts.node = this.opts.node;
    const picked = this.hub.pick(pickOpts);
    if (!picked.ok) return picked.result;
    const callOpts: { signal: AbortSignal; timeoutMs: number; onProgress?: (m: string) => void } = {
      signal,
      timeoutMs: this.opts.timeoutMs,
    };
    if (this.opts.onProgress) callOpts.onProgress = this.opts.onProgress;
    return picked.session.call(request, callOpts);
  }
}
