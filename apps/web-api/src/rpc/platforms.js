import { os } from './context';
export const platformsRouter = {
  list: os.platforms.list.handler(({ context }) => context.platforms.list()),
  set: os.platforms.set.handler(({ input, context }) =>
    context.platforms.set(input.id, input.fields),
  ),
  clear: os.platforms.clear.handler(({ input, context }) => context.platforms.clear(input.id)),
  botsListTelegram: os.platforms.botsListTelegram.handler(({ context }) =>
    context.platforms.listTelegramBots(),
  ),
  botsAddTelegram: os.platforms.botsAddTelegram.handler(({ input, context }) =>
    context.platforms.addTelegramBot(input.token, input.bind),
  ),
  botsRemoveTelegram: os.platforms.botsRemoveTelegram.handler(({ input, context }) =>
    context.platforms.removeTelegramBot(input.botKey),
  ),
  botsListSlack: os.platforms.botsListSlack.handler(({ context }) =>
    context.platforms.listSlackApps(),
  ),
  botsAddSlack: os.platforms.botsAddSlack.handler(({ input, context }) =>
    context.platforms.addSlackApp(
      { botToken: input.botToken, appToken: input.appToken, signingSecret: input.signingSecret },
      input.bind,
    ),
  ),
  botsRemoveSlack: os.platforms.botsRemoveSlack.handler(({ input, context }) =>
    context.platforms.removeSlackApp(input.botKey),
  ),
  getChannelFilter: os.platforms.getChannelFilter.handler(({ input, context }) =>
    context.platforms.getChannelFilter(input.platform),
  ),
  setChannelFilter: os.platforms.setChannelFilter.handler(({ input, context }) =>
    context.platforms.setChannelFilter(input.platform, input.filter),
  ),
};
