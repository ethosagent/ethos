export function buildAuthorizationUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
  audience?: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (params.scopes?.length) {
    query.set('scope', params.scopes.join(' '));
  }
  if (params.audience) {
    query.set('resource', params.audience);
  }
  return `${params.authorizationEndpoint}?${query.toString()}`;
}
