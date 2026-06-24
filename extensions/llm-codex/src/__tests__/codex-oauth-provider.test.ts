import { describe, expect, it } from 'vitest';
import { codexCustomFlowProvider } from '../codex-oauth-provider';

describe('codexCustomFlowProvider', () => {
  it('has the correct id', () => {
    expect(codexCustomFlowProvider.id).toBe('codex-device-auth');
  });

  it('sets Authorization header via authorizeRequest', () => {
    const req = { headers: {} as Record<string, string> };
    const token = { access_token: 'test-token' };
    const creds = { clientId: 'test-client' };

    codexCustomFlowProvider.authorizeRequest(req, token, creds);

    expect(req.headers.Authorization).toBe('Bearer test-token');
  });
});
