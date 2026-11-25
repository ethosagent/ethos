import { os } from './context';

export const platformsRouter = {
  list: os.platforms.list.handler(({ context }) => context.platforms.list()),

  set: os.platforms.set.handler(({ input, context }) =>
    context.platforms.set(input.id, input.fields),
  ),

  clear: os.platforms.clear.handler(({ input, context }) => context.platforms.clear(input.id)),

  validate: os.platforms.validate.handler(({ input, context }) =>
    context.platforms.validate(input.id, input.fields),
  ),

  botsListTelegram: os.platforms.botsListTelegram.handler(({ context }) =>
    context.platforms.listTelegramBots(),
  ),

  botsAddTelegram: os.platforms.botsAddTelegram.handler(({ input, context }) =>
    context.platforms.addTelegramBot(input.token, input.bind, input.username),
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

  botsListWhatsApp: os.platforms.botsListWhatsApp.handler(({ context }) =>
    context.platforms.listWhatsApp(),
  ),

  botsAddWhatsApp: os.platforms.botsAddWhatsApp.handler(({ input, context }) =>
    context.platforms.addWhatsApp({
      id: input.id,
      defaultMode: input.defaultMode,
      allowedNumbers: input.allowedNumbers,
      phoneNumber: input.phoneNumber,
      bind: input.bind,
    }),
  ),

  botsRemoveWhatsApp: os.platforms.botsRemoveWhatsApp.handler(({ input, context }) =>
    context.platforms.removeWhatsApp(input.botKey),
  ),

  getChannelFilter: os.platforms.getChannelFilter.handler(({ input, context }) =>
    context.platforms.getChannelFilter(input.platform),
  ),

  setChannelFilter: os.platforms.setChannelFilter.handler(({ input, context }) =>
    context.platforms.setChannelFilter(input.platform, input.filter),
  ),

  listRoomPolicies: os.platforms.listRoomPolicies.handler(({ input, context }) =>
    context.roomPolicies.listRoomPolicies(input),
  ),

  setRoomPolicy: os.platforms.setRoomPolicy.handler(({ input, context }) =>
    context.roomPolicies.setRoomPolicy(input),
  ),

  deleteRoomPolicy: os.platforms.deleteRoomPolicy.handler(({ input, context }) =>
    context.roomPolicies.deleteRoomPolicy(input),
  ),

  previewRoomPolicy: os.platforms.previewRoomPolicy.handler(({ input, context }) =>
    context.roomPolicies.previewRoomPolicy(input),
  ),

  listRecentRooms: os.platforms.listRecentRooms.handler(({ input, context }) =>
    context.roomPolicies.listRecentRooms(input),
  ),

  setRoomPlatformSettings: os.platforms.setRoomPlatformSettings.handler(({ input, context }) =>
    context.roomPolicies.setRoomPlatformSettings(input),
  ),
};
