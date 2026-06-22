import { describe, it, expect } from 'vitest'
import { buildDcrRequest, parseDcrResponse } from '../dcr'

describe('buildDcrRequest', () => {
  it('sets correct defaults', () => {
    const result = buildDcrRequest({
      redirectUris: ['http://localhost:3000/callback'],
      clientName: 'Test App',
    })
    expect(result).toEqual({
      redirect_uris: ['http://localhost:3000/callback'],
      client_name: 'Test App',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  })

  it('includes scope if provided', () => {
    const result = buildDcrRequest({
      redirectUris: ['http://localhost:3000/callback'],
      clientName: 'Test App',
      scope: 'openid profile',
    })
    expect(result.scope).toBe('openid profile')
  })
})

describe('parseDcrResponse', () => {
  it('extracts client_id', () => {
    const result = parseDcrResponse({ client_id: 'abc123' })
    expect(result.client_id).toBe('abc123')
  })

  it('throws on missing client_id', () => {
    expect(() => parseDcrResponse({})).toThrow('client_id')
  })

  it('preserves client_secret when present', () => {
    const result = parseDcrResponse({
      client_id: 'abc123',
      client_secret: 'secret456',
    })
    expect(result.client_secret).toBe('secret456')
  })
})
