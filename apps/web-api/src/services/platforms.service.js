export class PlatformsService {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async list() {
        return { platforms: await this.opts.repo.listStatus() };
    }
    async set(id, fields) {
        return { platform: await this.opts.repo.set(id, fields) };
    }
    async clear(id) {
        return { platform: await this.opts.repo.clear(id) };
    }
    async listTelegramBots() {
        return { bots: await this.opts.repo.listTelegramBots() };
    }
    async addTelegramBot(token, bind, username) {
        return { bot: await this.opts.repo.addTelegramBot(token, bind, username) };
    }
    async removeTelegramBot(botKey) {
        await this.opts.repo.removeTelegramBot(botKey);
        return { ok: true };
    }
    async listSlackApps() {
        return { bots: await this.opts.repo.listSlackApps() };
    }
    async addSlackApp(tokens, bind) {
        return { bot: await this.opts.repo.addSlackApp(tokens, bind) };
    }
    async removeSlackApp(botKey) {
        await this.opts.repo.removeSlackApp(botKey);
        return { ok: true };
    }
    async getChannelFilter(platform) {
        return { filter: await this.opts.repo.getChannelFilter(platform) };
    }
    async setChannelFilter(platform, filter) {
        return { filter: await this.opts.repo.setChannelFilter(platform, filter) };
    }
}
