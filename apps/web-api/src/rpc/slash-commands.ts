import { os } from './context';

export const slashCommandsRouter = {
  list: os.slashCommands.list.handler(({ context }) => {
    const pluginLoader = context.pluginLoader;
    const commands = pluginLoader ? pluginLoader.getAllSlashCommands().map((c) => ({ ...c })) : [];
    return { commands };
  }),
};
