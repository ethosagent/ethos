import { listFiles, resolveRefs } from '../services/context-resolve.service';
import { os } from './context';

export const contextRouter = {
  resolve: os.context.resolve.handler(async ({ input }) => {
    const resolved = await resolveRefs(input.refs);
    return { resolved };
  }),
};

export const filesRouter = {
  list: os.files.list.handler(({ input }) => {
    return listFiles(input.prefix);
  }),
};
