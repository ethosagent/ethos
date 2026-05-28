export class MeshService {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async list() {
        const entries = await this.opts.mesh.list();
        return { agents: entries.map(toWireAgent) };
    }
    async routeTest(capability) {
        const picked = await this.opts.mesh.route(capability);
        if (!picked) {
            return {
                ok: false,
                routedTo: null,
                reason: `No live mesh agent advertises capability "${capability}".`,
            };
        }
        return { ok: true, routedTo: picked.agentId, reason: null };
    }
}
function toWireAgent(entry) {
    return {
        agentId: entry.agentId,
        capabilities: entry.capabilities,
        activeSessions: entry.activeSessions,
        lastSeenAt: new Date(entry.lastHeartbeatAt).toISOString(),
    };
}
