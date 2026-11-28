import { oc } from '@orpc/contract';
import {
  ConstitutionInitiativesOutputSchema,
  ConstitutionInitiativesSaveInputSchema,
  ConstitutionInitiativesSaveOutputSchema,
  ExploringNowInputSchema,
  ExploringNowOutputSchema,
  InitiativeActivityInputSchema,
  InitiativeActivityOutputSchema,
  InitiativeDecideInputSchema,
  InitiativeDecideOutputSchema,
  InitiativeGetInputSchema,
  InitiativeGetOutputSchema,
  InitiativeListInputSchema,
  InitiativeListOutputSchema,
  InitiativeMetricsInputSchema,
  InitiativeMetricsOutputSchema,
  InitiativesSettingsInputSchema,
  InitiativesSettingsOutputSchema,
  InitiativesSettingsSaveInputSchema,
  InitiativesSettingsSaveOutputSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Initiative engine (plan Task 6.1). Owner cookie + CSRF only: neither
// namespace is in SCOPE_MAP, so bearer keys get 403 (Task 6.2 test).
// ---------------------------------------------------------------------------

/** @experimental */
export const initiatives = {
  list: oc.input(InitiativeListInputSchema).output(InitiativeListOutputSchema),
  get: oc.input(InitiativeGetInputSchema).output(InitiativeGetOutputSchema),
  activity: oc.input(InitiativeActivityInputSchema).output(InitiativeActivityOutputSchema),
  exploringNow: oc.input(ExploringNowInputSchema).output(ExploringNowOutputSchema),
  decide: oc.input(InitiativeDecideInputSchema).output(InitiativeDecideOutputSchema),
  settings: oc.input(InitiativesSettingsInputSchema).output(InitiativesSettingsOutputSchema),
  settingsSave: oc
    .input(InitiativesSettingsSaveInputSchema)
    .output(InitiativesSettingsSaveOutputSchema),
  metrics: oc.input(InitiativeMetricsInputSchema).output(InitiativeMetricsOutputSchema),
};

/** @experimental */
export const constitution = {
  initiatives: oc.output(ConstitutionInitiativesOutputSchema),
  initiativesSave: oc
    .input(ConstitutionInitiativesSaveInputSchema)
    .output(ConstitutionInitiativesSaveOutputSchema),
};
