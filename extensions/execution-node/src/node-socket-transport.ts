/**
 * The client-side socket seam, like extensions/voice-satellite/src/ws-socket.ts: NodeClient carries
 * no transport, so tests drive it with a fake. This is the only client-side file importing `ws`.
 */
import { WebSocket } from 'ws';

export interface NodeSocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onClose(code: number, reason: string): void;
  onError(err: Error): void;
  onUnexpectedResponse(status: number): void;
}
export interface NodeSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}
export type NodeSocketFactory = (
  url: string,
  init: { headers?: Record<string, string>; maxPayload: number },
  h: NodeSocketHandlers,
) => NodeSocket;

export const createWsNodeSocket: NodeSocketFactory = (url, init, h) => {
  const socket = new WebSocket(url, {
    maxPayload: init.maxPayload,
    ...(init.headers ? { headers: init.headers } : {}),
  });
  socket.on('open', () => h.onOpen());
  socket.on('message', (data, isBinary) => {
    // Frames are JSON text only; a binary frame is a protocol violation.
    if (isBinary) {
      socket.close(1008, 'binary frames are not supported');
      return;
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(new Uint8Array(data)).toString('utf8');
    h.onText(text);
  });
  socket.on('unexpected-response', (req, res) => {
    h.onUnexpectedResponse(res.statusCode ?? 0);
    req.destroy();
  });
  socket.on('error', (err) => h.onError(err));
  socket.on('close', (code, reason) => h.onClose(code, reason.toString('utf8')));
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
};
