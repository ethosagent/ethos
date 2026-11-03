# @ethosagent/design-tokens

## Purpose

DESIGN.md tokens as runtime data: colours, typography, spacing and per-personality accents, plus skins and adapters that render them for each surface (Ant Design, chalk, inline CSS, VS Code). Surfaces import tokens from here instead of writing literals.

## Public surface

Main entry `@ethosagent/design-tokens`, plus subpath exports `@ethosagent/design-tokens/antd`, `/chalk`, `/inline-css` and `/vscode` (see `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `Tokens` | interface | Shape of the token set. |
| `DEFAULT_TOKENS` | const | Default tokens mirroring DESIGN.md. |
| `accentFor` | function | Accent colour for a personality id given a token set. |
| `personalityAccent` | function | Accent colour for a personality id. |
| `isBuiltinPersonality` | function | Whether an id is a built-in personality. |
| `BUILTIN_PERSONALITY_IDS` | const | Built-in personality ids. |
| `TypographyRole` | type | Typography role names. |
| `SpacingKey` | type | Spacing scale keys. |
| `Skin` | type | A skin definition. |
| `BUILTIN_SKINS` | const | Built-in skins. |
| `resolveSkin` | function | Resolves a skin. |
| `defaultSkin` | const | The default skin. |
| `validateTokens` | function | Validates a token set. |
| `validateSkin` | function | Validates a skin. |
| `contrastRatio` | function | Contrast ratio of two colours. |

## Seam

Support package; the written source of truth is DESIGN.md (see `.claude/rules/ui-design.md`). Archcheck layer: `support`.

Pinned behaviours:
- `DEFAULT_TOKENS` matches DESIGN.md in both directions: `src/__tests__/design-md-parity.test.ts`.
- No hex literals in the gated TUI, web theme and `apps/ethos/src` files: `src/__tests__/no-hex-literals.test.ts`.

## Testing

```
pnpm vitest run packages/design-tokens
```

Pinning tests:
- `src/__tests__/design-md-parity.test.ts`: tokens equal DESIGN.md.
- `src/__tests__/no-hex-literals.test.ts`: hex-literal guard.
- `src/__tests__/validate.test.ts`: token and skin validation.
- `src/__tests__/skins.test.ts`, `src/__tests__/accents.test.ts`, `src/__tests__/adapters.test.ts`, `src/__tests__/antd-adapter.test.ts`: skins, accents and adapters.
