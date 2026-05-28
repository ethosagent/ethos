import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
/** Maximum number of concurrent MCP session views. */
const MAX_ACP_SESSIONS = 100;
// ---------------------------------------------------------------------------
// AcpServer — JSON-RPC 2.0 transport over stdio, HTTP, and WebSocket
//
// Stdio protocol (existing):
//   Request:      {"jsonrpc":"2.0","id":1,"method":"...","params":{...}}\n
//   Notification: {"jsonrpc":"2.0","method":"$/stream","params":{"requestId":1,"event":{...}}}\n
//   Response:     {"jsonrpc":"2.0","id":1,"result":{...}}\n
//   Error:        {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}\n
//
// HTTP transport (Phase 24):
//   POST /rpc — synchronous JSON-RPC (prompt runs to completion, no streaming)
//   GET  /ws  — WebSocket with same streaming protocol as stdio
// ---------------------------------------------------------------------------
export class AcpServer {
    runner;
    session;
    input;
    output;
    mesh;
    abortControllers = new Map();
    // tracks which sessionKeys have an active prompt
    busySessions = new Set();
    startedAt = Date.now();
    lastTurnAt = null;
    // Phase 5 — client-provided MCP servers
    _resolveAllowlist;
    _createSessionView;
    _sessionViews = new Map();
    /** Bearer token required for all authenticated endpoints. */
    _authToken;
    constructor(config) {
        this.runner = config.runner;
        this.session = config.session;
        this.input = config.input ?? process.stdin;
        this.output = config.output ?? process.stdout;
        this.mesh = config.mesh;
        this._resolveAllowlist = config.resolveAllowlist;
        this._createSessionView = config.createSessionView;
        this._authToken = config.authToken ?? randomBytes(32).toString('hex');
    }
    /** Returns the bearer token clients must present to access authenticated endpoints. */
    get token() {
        return this._authToken;
    }
    get activeSessionCount() {
        return this.busySessions.size;
    }
    // ---------------------------------------------------------------------------
    // Stdio transport (original)
    // ---------------------------------------------------------------------------
    start() {
        const rl = createInterface({ input: this.input, terminal: false });
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            let req;
            try {
                req = JSON.parse(trimmed);
            }
            catch {
                this.sendError(null, -32700, 'Parse error');
                return;
            }
            if (req.id !== undefined) {
                void this.dispatch(req, (msg) => this.send(msg)).catch(() => { });
            }
        });
    }
    // ---------------------------------------------------------------------------
    // HTTP + WebSocket transport (Phase 24)
    // ---------------------------------------------------------------------------
    startHttp(port) {
        const host = process.env.ETHOS_ACP_BIND_ALL === '1' ? '0.0.0.0' : '127.0.0.1';
        const httpServer = createHttpServer((req, res) => {
            void this.handleHttpRequest(req, res).catch((err) => {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err) }));
                }
            });
        });
        const wss = new WebSocketServer({ noServer: true });
        httpServer.on('upgrade', (req, socket, head) => {
            // Only handle /ws path
            if (req.url !== '/ws') {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }
            // Origin validation — block DNS rebinding
            const origin = req.headers.origin;
            if (origin) {
                let url;
                try {
                    url = new URL(origin);
                }
                catch {
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }
                if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
            // Bearer token authentication
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${this._authToken}`) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
        wss.on('connection', (ws) => this.handleWsConnection(ws));
        httpServer.listen(port, host);
        return httpServer;
    }
    async handleHttpRequest(req, res) {
        // Health check is unauthenticated
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
                active_sessions: this.busySessions.size,
                last_turn_at: this.lastTurnAt ? new Date(this.lastTurnAt).toISOString() : null,
            }));
            return;
        }
        // Require bearer token for all other requests
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${this._authToken}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        if (req.method !== 'POST' || req.url !== '/rpc') {
            res.writeHead(404);
            res.end();
            return;
        }
        const body = await readBody(req);
        let rpcReq;
        try {
            rpcReq = JSON.parse(body);
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            }));
            return;
        }
        // For HTTP, run blocking (no intermediate streaming)
        const response = await this.handleHttpRpc(rpcReq);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }
    async handleHttpRpc(req) {
        const id = req.id ?? null;
        try {
            switch (req.method) {
                case 'initialize':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: '1.0',
                            serverName: 'ethos',
                            capabilities: { streaming: true },
                        },
                    };
                case 'new_session':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            sessionKey: `acp:${randomUUID()}`,
                            personalityId: req.params?.personalityId ?? null,
                        },
                    };
                case 'prompt': {
                    const p = req.params;
                    if (this.busySessions.has(p.sessionKey)) {
                        return {
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32000, message: `Session ${p.sessionKey} has a prompt in progress` },
                        };
                    }
                    this.busySessions.add(p.sessionKey);
                    try {
                        const { text, turnCount } = await this.runBlocking(p.text, p.sessionKey, p.personalityId);
                        this.lastTurnAt = Date.now();
                        return { jsonrpc: '2.0', id, result: { text, turnCount } };
                    }
                    finally {
                        this.busySessions.delete(p.sessionKey);
                    }
                }
                case 'session/registerMcpServers': {
                    const p = req.params;
                    const result = await this.handleRegisterMcpServers(p);
                    return { jsonrpc: '2.0', id, result };
                }
                case 'session/end': {
                    const p = req.params;
                    await this.handleSessionEnd(p.sessionKey);
                    return { jsonrpc: '2.0', id, result: { ok: true } };
                }
                case 'mesh.register': {
                    const p = req.params;
                    if (!this.mesh)
                        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Mesh not configured' } };
                    await this.mesh.register(p);
                    return { jsonrpc: '2.0', id, result: { ok: true } };
                }
                case 'mesh.status':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: { agents: this.mesh ? await this.mesh.list() : [] },
                    };
                default:
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: `Method not found: ${req.method}` },
                    };
            }
        }
        catch (err) {
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            };
        }
    }
    handleWsConnection(ws) {
        const send = (msg) => {
            if (ws.readyState === ws.OPEN)
                ws.send(JSON.stringify(msg));
        };
        const abortControllers = new Map();
        ws.on('message', (data) => {
            let req;
            try {
                req = JSON.parse(data.toString());
            }
            catch {
                send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                return;
            }
            if (req.id !== undefined) {
                void this.dispatch(req, send, abortControllers).catch(() => { });
            }
        });
        ws.on('close', () => {
            for (const ac of abortControllers.values())
                ac.abort();
        });
    }
    // ---------------------------------------------------------------------------
    // Core dispatch — used by both stdio and WebSocket transports
    // ---------------------------------------------------------------------------
    async dispatch(req, send, abortControllers) {
        const id = req.id ?? null;
        const controllers = abortControllers ?? this.abortControllers;
        const sendResult = (result) => send({ jsonrpc: '2.0', id, result });
        const sendError = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
        const sendStream = (event) => send({ jsonrpc: '2.0', method: '$/stream', params: { requestId: id, event } });
        try {
            switch (req.method) {
                case 'initialize':
                    sendResult({
                        protocolVersion: '1.0',
                        serverName: 'ethos',
                        capabilities: { streaming: true },
                    });
                    break;
                case 'new_session':
                    sendResult({
                        sessionKey: `acp:${randomUUID()}`,
                        personalityId: req.params?.personalityId ?? null,
                    });
                    break;
                case 'prompt': {
                    const p = req.params;
                    if (this.busySessions.has(p.sessionKey)) {
                        sendError(-32000, `Session ${p.sessionKey} has a prompt in progress`);
                        return;
                    }
                    const ac = new AbortController();
                    controllers.set(id, ac);
                    this.busySessions.add(p.sessionKey);
                    try {
                        let fullText = '';
                        let turnCount = 0;
                        for await (const event of this.runner.run(p.text, {
                            sessionKey: p.sessionKey,
                            personalityId: p.personalityId,
                            abortSignal: ac.signal,
                        })) {
                            if (event.type === 'done') {
                                turnCount = event.turnCount;
                            }
                            else {
                                if (event.type === 'text_delta')
                                    fullText += event.text;
                                sendStream(event);
                            }
                        }
                        this.lastTurnAt = Date.now();
                        sendResult({ text: fullText, turnCount });
                    }
                    finally {
                        controllers.delete(id);
                        this.busySessions.delete(p.sessionKey);
                    }
                    break;
                }
                case 'cancel': {
                    const p = req.params;
                    controllers.get(p.requestId)?.abort();
                    sendResult({ ok: true });
                    break;
                }
                case 'fork_session':
                    await this.handleForkSession(id, req.params, send);
                    break;
                case 'resume_session':
                    await this.handleResumeSession(id, req.params, send);
                    break;
                case 'session/registerMcpServers': {
                    const p = req.params;
                    const result = await this.handleRegisterMcpServers(p);
                    sendResult(result);
                    break;
                }
                case 'session/end': {
                    const p = req.params;
                    await this.handleSessionEnd(p.sessionKey);
                    sendResult({ ok: true });
                    break;
                }
                case 'mesh.register': {
                    const p = req.params;
                    if (!this.mesh) {
                        sendError(-32000, 'Mesh not configured');
                        return;
                    }
                    await this.mesh.register(p);
                    sendResult({ ok: true });
                    break;
                }
                case 'mesh.status':
                    sendResult({ agents: this.mesh ? await this.mesh.list() : [] });
                    break;
                default:
                    sendError(-32601, `Method not found: ${req.method}`);
            }
        }
        catch (err) {
            sendError(-32000, err instanceof Error ? err.message : String(err));
        }
    }
    // ---------------------------------------------------------------------------
    // Phase 5 — session/registerMcpServers handler
    // ---------------------------------------------------------------------------
    async handleRegisterMcpServers(params) {
        if (!this._createSessionView) {
            return {
                registered: [],
                rejected: params.servers.map((s) => ({
                    name: s.name,
                    reason: 'MCP session views not configured on this server',
                })),
            };
        }
        const sessionKey = params.sessionKey ?? `acp:ephemeral:${randomUUID()}`;
        const allowlist = this._resolveAllowlist?.(params.personalityId);
        let view = this._sessionViews.get(sessionKey);
        if (!view) {
            if (this._sessionViews.size >= MAX_ACP_SESSIONS) {
                return {
                    registered: [],
                    rejected: params.servers.map((s) => ({
                        name: s.name,
                        reason: `Session limit reached (max ${MAX_ACP_SESSIONS})`,
                    })),
                };
            }
            view = this._createSessionView();
            this._sessionViews.set(sessionKey, view);
        }
        return view.registerSessionServers(params.servers, allowlist);
    }
    async handleSessionEnd(sessionKey) {
        const view = this._sessionViews.get(sessionKey);
        if (view) {
            await view.teardown();
            this._sessionViews.delete(sessionKey);
        }
    }
    // ---------------------------------------------------------------------------
    // Session helpers
    // ---------------------------------------------------------------------------
    async handleForkSession(id, params, send) {
        const sendResult = (r) => send({ jsonrpc: '2.0', id, result: r });
        const sendError = (code, msg) => send({ jsonrpc: '2.0', id, error: { code, message: msg } });
        const source = await this.session.getSessionByKey(params.sessionKey);
        if (!source) {
            sendError(-32000, `Session not found: ${params.sessionKey}`);
            return;
        }
        const messages = await this.session.getMessages(source.id, { limit: 10_000 });
        const newKey = `acp:fork:${randomUUID()}`;
        const forked = await this.session.createSession({
            key: newKey,
            platform: source.platform,
            model: source.model,
            provider: source.provider,
            personalityId: source.personalityId,
            workingDir: source.workingDir,
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                estimatedCostUsd: 0,
                apiCallCount: 0,
                compactionCount: 0,
            },
        });
        for (const msg of messages) {
            await this.session.appendMessage({
                sessionId: forked.id,
                role: msg.role,
                content: msg.content,
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                toolCalls: msg.toolCalls,
            });
        }
        sendResult({ sessionKey: newKey });
    }
    async handleResumeSession(id, params, send) {
        const sendResult = (r) => send({ jsonrpc: '2.0', id, result: r });
        const s = await this.session.getSessionByKey(params.sessionKey);
        if (!s) {
            sendResult({ exists: false, messageCount: 0 });
            return;
        }
        const messages = await this.session.getMessages(s.id, { limit: 10_000 });
        sendResult({ exists: true, messageCount: messages.length });
    }
    // ---------------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------------
    async runBlocking(text, sessionKey, personalityId) {
        let fullText = '';
        let turnCount = 0;
        for await (const event of this.runner.run(text, { sessionKey, personalityId })) {
            if (event.type === 'text_delta')
                fullText += event.text;
            if (event.type === 'done')
                turnCount = event.turnCount;
            if (event.type === 'error')
                throw new Error(event.error);
        }
        return { text: fullText.trim(), turnCount };
    }
    send(msg) {
        this.output.write(`${JSON.stringify(msg)}\n`);
    }
    // Keep legacy private helpers for stdio compat (still called by start() via dispatch)
    sendError(id, code, message) {
        this.send({ jsonrpc: '2.0', id, error: { code, message } });
    }
}
// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
