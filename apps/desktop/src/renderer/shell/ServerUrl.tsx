import { createContext, useContext } from 'react';

// The single place the local-backend URL literal lives. Everything else in
// the renderer resolves the server URL via useServerUrl(), which AppShell
// provides — localhost in local mode, the configured server in remote mode.
export const localServerUrl = (port: number): string => `http://localhost:${port}`;

export const ServerUrlContext = createContext<string>(localServerUrl(3001));
export const useServerUrl = () => useContext(ServerUrlContext);
