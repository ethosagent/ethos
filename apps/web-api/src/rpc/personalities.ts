import { os } from './context';

// Personalities namespace — list/get/create/update/delete/duplicate
// plus per-personality skills CRUD + import-from-global. Handlers stay
// thin; mutations route through PersonalitiesService.

export const personalitiesRouter = {
  list: os.personalities.list.handler(({ context }) => context.personalities.list()),

  get: os.personalities.get.handler(({ input, context }) => context.personalities.get(input.id)),

  characterSheet: os.personalities.characterSheet.handler(({ input, context }) =>
    context.personalities.characterSheet(input.id),
  ),

  create: os.personalities.create.handler(({ input, context }) =>
    context.personalities.create({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      toolset: input.toolset,
      soulMd: input.soulMd,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(input.mcp_servers !== undefined ? { mcp_servers: input.mcp_servers } : {}),
      ...(input.plugins !== undefined ? { plugins: input.plugins } : {}),
      ...(input.fs_reach !== undefined ? { fs_reach: input.fs_reach } : {}),
    }),
  ),

  update: os.personalities.update.handler(async ({ input, context }) => {
    const { id, mcp_servers, mcp_tools, plugins, capabilities, provider, fs_reach, ...rest } =
      input;
    const result = await context.personalities.update(id, {
      ...rest,
      ...(mcp_servers !== undefined ? { mcp_servers } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(fs_reach !== undefined ? { fs_reach } : {}),
    });
    // Per-server MCP tool subsets are an off-schema sibling (`mcp.yaml`),
    // written after the config update. Ignored unless `mcp_servers` was
    // also supplied — `mcp_tools` alone has no attached servers to scope.
    if (mcp_servers !== undefined && mcp_tools !== undefined) {
      const subsets: Record<string, string[] | null> = {};
      for (const server of mcp_servers) {
        // A server with an explicit subset → write the list; a server with
        // every tool selected is omitted from `mcp_tools` by the UI → null
        // clears any prior subset back to default-allow.
        subsets[server] = mcp_tools[server] ?? null;
      }
      await context.personalities.writeMcpToolSubsets(id, subsets);
    }
    return result;
  }),

  delete: os.personalities.delete.handler(async ({ input, context }) => {
    // Risk #3: warn server-side if cron jobs still reference this personality.
    // They will fail gracefully at trigger time with CRON_PERSONALITY_MISSING.
    const { jobs } = await context.cron.list();
    const dependent = (jobs as Array<{ personality: string | null; name: string }>).filter(
      (j) => j.personality === input.id,
    );
    if (dependent.length > 0) {
      const names = dependent.map((j) => j.name).join(', ');
      console.warn(
        `[personalities] Deleting "${input.id}" but ${dependent.length} cron job(s) still reference it: ${names}`,
      );
    }
    await context.personalities.delete(input.id);
    return { ok: true as const };
  }),

  duplicate: os.personalities.duplicate.handler(({ input, context }) =>
    context.personalities.duplicate(input.id, input.newId),
  ),

  skillsList: os.personalities.skillsList.handler(({ input, context }) =>
    context.personalities.skillsList(input.personalityId),
  ),

  skillsGet: os.personalities.skillsGet.handler(({ input, context }) =>
    context.personalities.skillsGet(input.personalityId, input.skillId),
  ),

  skillsCreate: os.personalities.skillsCreate.handler(({ input, context }) =>
    context.personalities.skillsCreate(input.personalityId, input.skillId, input.body),
  ),

  skillsUpdate: os.personalities.skillsUpdate.handler(({ input, context }) =>
    context.personalities.skillsUpdate(input.personalityId, input.skillId, input.body),
  ),

  skillsDelete: os.personalities.skillsDelete.handler(async ({ input, context }) => {
    await context.personalities.skillsDelete(input.personalityId, input.skillId);
    return { ok: true as const };
  }),

  skillsImportGlobal: os.personalities.skillsImportGlobal.handler(({ input, context }) =>
    context.personalities.skillsImportGlobal(input.personalityId, input.skillIds),
  ),
};
