/**
 * The laptop-node lane as one unit: the socket, the pairing state and the cookie-only admin
 * routes (plan laptop-tool-node D2, T7). `createWebApi` builds it when `nodes` is passed.
 */
import type { ApiKeyAdminStore } from '../middleware/bearer-auth';
import type { RouteModule } from '../routes/route-module';
import { nodeAdminRoutes } from './node-admin-routes';
import { NodePairing } from './node-pairing';
import { createNodeSocket, type NodeSocket, type NodeSocketOptions } from './node-socket';

export function createNodeLane(
  opts: Omit<NodeSocketOptions, 'pairing' | 'apiKeys'> & { apiKeys: ApiKeyAdminStore },
): { socket: NodeSocket; pairing: NodePairing; routeModule: RouteModule; close(): Promise<void> } {
  const pairing = new NodePairing({ apiKeys: opts.apiKeys });
  const socket = createNodeSocket({
    ...opts,
    pairing,
  });
  return {
    socket,
    pairing,
    routeModule: {
      basePath: '/node/admin',
      router: nodeAdminRoutes({ hub: opts.hub, pairing }),
      auth: 'cookie',
      description:
        "Laptop tool nodes: list connected nodes and approve a pairing code (cookie-only; the operator's CLI sends the web token).",
    },
    close: () => socket.close(),
  };
}
