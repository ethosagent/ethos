import { os } from './context';
export const metaRouter = {
    capabilities: os.meta.capabilities.handler(() => ({
        capabilities: { byok: true },
    })),
};
