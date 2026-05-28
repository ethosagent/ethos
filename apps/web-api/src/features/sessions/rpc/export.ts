import { os } from '../../../rpc/context';

export const sessionsExport = os.sessions.export.handler(({ input, context }) =>
  context.sessions.export(input.id, input.format),
);
