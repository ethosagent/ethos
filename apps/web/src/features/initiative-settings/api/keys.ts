// Query keys for the two initiative config surfaces: the Personality tab
// (`personalities/<id>/initiatives/settings.yaml`) and the Settings section
// (constitution `initiatives` block). Both go through the web-api
// InitiativesService, the only writer of either file.
export const initiativeSettingsKeys = {
  personality: (id: string) => ['initiatives', 'settings', id] as const,
  constitution: () => ['constitution', 'initiatives'] as const,
};
