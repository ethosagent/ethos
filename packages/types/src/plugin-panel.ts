export interface PluginPanelProps {
  pluginId: string;
  getCredential(ref: string): Promise<string | null>;
  setCredential(ref: string, value: string): Promise<void>;
  credentialPreview(ref: string): Promise<string | null>;
  requestOAuth(oauthRef: string): void;
  executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; value?: string; error?: string; code?: string }>;
  theme: 'dark' | 'light';
}

export interface PluginCredentialSchema {
  ref: string;
  label: string;
  kind: 'text' | 'secret' | 'oauth';
  description?: string;
  oauthRef?: string;
}
