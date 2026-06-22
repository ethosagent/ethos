export type {
  OAuthProviderProfile,
  RedirectStrategy,
  CredentialRef,
  OAuthService,
  UserPrompt,
  CustomFlowProvider,
  OAuthRegistry,
  TokenSet,
  ClientCreds,
  GrantInput,
  HttpRequest,
} from './types'

export type { OAuthServerMetadata, ProtectedResourceMetadata } from './discovery'
export {
  buildOAuthMetadataUrl,
  buildProtectedResourceMetadataUrl,
  parseOAuthServerMetadata,
  parseProtectedResourceMetadata,
} from './discovery'

export type { DcrRequest, DcrResponse } from './dcr'
export { buildDcrRequest, parseDcrResponse } from './dcr'
