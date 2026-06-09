import { createContext, useContext } from 'react';

export const ServerUrlContext = createContext<string>('http://localhost:3001');
export const useServerUrl = () => useContext(ServerUrlContext);
