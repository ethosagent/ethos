import { getClientId } from '../clientId';
import { clearLastSessionId, getLastSessionId, setLastSessionId } from '../lastSession';

export const tokenStorage = {
  getClientId,
  getLastSession: getLastSessionId,
  setLastSession: setLastSessionId,
  clearAll() {
    // clientId is intentionally NOT cleared — it's a tab identity, not auth
    clearLastSessionId();
  },
};
