import { os } from './context';

export const slashCommandsRouter = {
  list: os.slashCommands.list.handler(({ context }) => {
    const pluginLoader = context.pluginLoader;
    // Builtin slash commands (help, new, personality, etc.) are defined in
    // the CLI app layer (apps/ethos/src/lib/slash-commands.ts) and are not
    // available in the web-api context. Only plugin-registered commands are
    // surfaced here. Moving builtins to a shared package would unify both
    // surfaces — tracked as a future improvement.
    const commands = pluginLoader ? pluginLoader.getAllSlashCommands().map((c) => ({ ...c })) : [];
    return { commands };
  }),
};
