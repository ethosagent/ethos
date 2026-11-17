import type { PersonalityVoice } from '../../components/personality/PersonalityVoiceFields';

/** Frame 4's behaviour line, under both model pickers. */
export const MODEL_FIELD_HELP =
  'Choose a role to follow whatever that role is bound to. Choose a model to pin this personality to it.';

export interface WizardState {
  id: string;
  name: string;
  description: string;
  /** A role, a registry alias, or `''` for "Use default" (plan model-registry D1). */
  model: string;
  capabilities: string[];
  fsReachRead: string[];
  fsReachWrite: string[];
  fsReachWorkdir: string[];
  toolset: string[];
  soulMd: string;
  skills: string[];
  plugins: string[];
  skillEvolutionEnabled: boolean;
  skillEvolutionMinToolCalls: number;
  skillEvolutionCooldownMinutes: number;
  evolutionApprovalMode: 'auto' | 'user';
  /** The whole `voice` block as the editor holds it. One object rather than a
   *  field per sub-key: the language map is a list, and flattening a list into
   *  wizard state buys nothing. */
  voice: PersonalityVoice;
}

/** No `voice` block at all — every sub-key unset. */
export const BLANK_VOICE: PersonalityVoice = {
  ttsProvider: '',
  ttsVoice: '',
  sttProvider: '',
  realtimeProvider: '',
  callStyle: '',
  tier: '',
  model: '',
  languages: [],
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the UI, not a template variable
export const FS_REACH_READ_PLACEHOLDER = 'e.g. /data, ${self}/docs';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the UI, not a template variable
export const FS_REACH_WORKDIR_PLACEHOLDER = 'e.g. ${ETHOS_HOME}/workspace/${self}';

export const FS_REACH_READ_HELP = 'Directories this personality may read from.';

export const FS_REACH_WRITE_HELP = 'Directories this personality may write to.';

// The asymmetry users get wrong: a tool that declares NO hosts of its own
// delegates the whole decision to this list, while a tool that declares its own
// hosts is intersected with it — narrowed, never widened.
export const NET_ALLOW_HELP =
  '‘*’ allows any public host. Otherwise list exact hosts (api.open-meteo.com) or one leading wildcard (*.example.com). The non-overridable floor still blocks cloud-metadata endpoints and private (RFC1918) addresses, whatever is listed here.';

export const NET_DENY_HELP = 'Hosts refused even when the allow list would permit them.';

export const FS_REACH_WORKDIR_HELP =
  'Where bare filenames land — the output home for this personality, and what the Documents tab lists for download and deletion. Declare several to give Documents several roots; the first is also the agent’s own working directory. Recommended: without one, the Documents tab has nothing to show.';
