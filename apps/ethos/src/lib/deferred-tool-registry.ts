import type {
  Attachment,
  Tool,
  ToolContext,
  ToolDefinitionLite,
  ToolFilterOpts,
  ToolInvocationFilter,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';

interface PendingRegistration {
  tool: Tool;
  opts?: { pluginId?: string };
}

/**
 * ToolRegistry for onboarding mode: no real registry exists until the
 * first chat request boots the agent loop, but `createWebApi` registers
 * dashboard tools at construction time. Registrations are buffered until
 * `setInner()` hands over the real registry, then flushed in order.
 * Execution before that point fails soft with the same SETUP_REQUIRED
 * convention the onboarding stub loop uses.
 */
export class DeferredToolRegistry implements ToolRegistry {
  private inner: ToolRegistry | null = null;
  private pending: PendingRegistration[] = [];

  /** Set the real registry and flush buffered registrations into it, in order. */
  setInner(real: ToolRegistry): void {
    this.inner = real;
    for (const { tool, opts } of this.pending) {
      real.register(tool, opts);
    }
    this.pending = [];
  }

  register(tool: Tool, opts?: { pluginId?: string }): void {
    if (this.inner) {
      this.inner.register(tool, opts);
    } else {
      this.pending.push({ tool, opts });
    }
  }

  registerAll(tools: Tool[]): void {
    if (this.inner) {
      this.inner.registerAll(tools);
    } else {
      for (const tool of tools) this.pending.push({ tool });
    }
  }

  unregister(name: string): void {
    if (this.inner) {
      this.inner.unregister(name);
    } else {
      this.pending = this.pending.filter((p) => p.tool.name !== name);
    }
  }

  get(name: string): Tool | undefined {
    if (this.inner) return this.inner.get(name);
    return this.pending.find((p) => p.tool.name === name)?.tool;
  }

  getAvailable(): Tool[] {
    if (this.inner) return this.inner.getAvailable();
    return this.pending.map((p) => p.tool);
  }

  getForToolset(toolset: string): Tool[] {
    if (this.inner) return this.inner.getForToolset(toolset);
    return this.pending.filter((p) => p.tool.toolset === toolset).map((p) => p.tool);
  }

  getPluginId(name: string): string | undefined {
    if (this.inner) return this.inner.getPluginId?.(name);
    return this.pending.find((p) => p.tool.name === name)?.opts?.pluginId;
  }

  async executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
    turnAttachments?: Attachment[],
    filters?: ToolInvocationFilter[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>> {
    if (this.inner) {
      return this.inner.executeParallel(
        calls,
        ctx,
        allowedTools,
        filterOpts,
        turnAttachments,
        filters,
      );
    }
    return calls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      result: {
        ok: false as const,
        code: 'not_available' as const,
        error: 'Setup required — complete onboarding first.',
        reason: 'SETUP_REQUIRED',
      },
    }));
  }

  toDefinitions(allowedTools?: string[], filterOpts?: ToolFilterOpts): ToolDefinitionLite[] {
    if (this.inner) return this.inner.toDefinitions(allowedTools, filterOpts);
    return [];
  }
}
