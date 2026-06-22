export interface DcrRequest {
  redirect_uris: string[];
  client_name: string;
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  scope?: string;
}

export interface DcrResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

export function buildDcrRequest(params: {
  redirectUris: string[];
  clientName: string;
  scope?: string;
}): DcrRequest {
  const request: DcrRequest = {
    redirect_uris: params.redirectUris,
    client_name: params.clientName,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };

  if (params.scope !== undefined) {
    request.scope = params.scope;
  }

  return request;
}

export function parseDcrResponse(data: unknown): DcrResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('DCR response must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.client_id !== 'string') {
    throw new Error('client_id must be present and a string');
  }

  return {
    client_id: obj.client_id,
    client_secret: typeof obj.client_secret === 'string' ? obj.client_secret : undefined,
    client_id_issued_at: typeof obj.client_id_issued_at === 'number' ? obj.client_id_issued_at : undefined,
    registration_access_token:
      typeof obj.registration_access_token === 'string'
        ? obj.registration_access_token
        : undefined,
    registration_client_uri:
      typeof obj.registration_client_uri === 'string' ? obj.registration_client_uri : undefined,
  };
}
