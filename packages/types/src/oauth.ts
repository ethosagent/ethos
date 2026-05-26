export interface OAuthConfig {
  provider: string;
  buttonLabel: string;
  buildAuthUrl(params: { redirectUri: string; state: string }): string;
  onCallback(params: { code: string; redirectUri: string }): Promise<void>;
}
