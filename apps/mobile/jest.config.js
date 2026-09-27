// Component cases (`.test.tsx`) run under jest-expo + React Native Testing
// Library — the one component-test stack Expo documents (R13). The pure-TS
// cases stay under vitest.config.ts; `pnpm test` here runs both.
const preset = require('jest-expo/jest-preset');

const [modules, ...ignored] = preset.transformIgnorePatterns;

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.tsx'],
  // The root vitest config's budget: a first render is slow under transform contention.
  testTimeout: 15_000,
  // @orpc ships ESM only (`.mjs`), which the preset neither transforms nor allowlists.
  transform: { ...preset.transform, '\\.mjs$': preset.transform['\\.[jt]sx?$'] },
  transformIgnorePatterns: [modules.replace('(.pnpm|', '(.pnpm|@orpc|'), ...ignored],
  // Reanimated 4's worklets resolve to their JS (non-native) build under Jest.
  resolver: 'react-native-worklets/jest/resolver',
  // `@ethosagent/types` exports only ./dist; read its source, as tsconfig `paths` does.
  moduleNameMapper: {
    '^@ethosagent/types$': '<rootDir>/../../packages/types/src',
    // The call engine's native audio has no JS build under Jest; the library
    // ships its own mock (`src/voice/engine.ts` is the only importer).
    '^react-native-audio-api$': 'react-native-audio-api/mock',
  },
};
