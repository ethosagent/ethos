import type {
  CustomFlowProvider,
  OAuthProviderProfile,
  OAuthRegistry,
} from '@ethosagent/oauth-core';

export class DefaultOAuthRegistry implements OAuthRegistry {
  private readonly profiles = new Map<string, OAuthProviderProfile>();
  private readonly customFlows = new Map<string, CustomFlowProvider>();

  registerProfile(profile: OAuthProviderProfile): void {
    this.profiles.set(profile.id, profile);
  }

  registerCustomFlow(provider: CustomFlowProvider): void {
    this.customFlows.set(provider.id, provider);
  }

  getProfile(id: string): OAuthProviderProfile | undefined {
    return this.profiles.get(id);
  }

  getCustomFlow(id: string): CustomFlowProvider | undefined {
    return this.customFlows.get(id);
  }
}
