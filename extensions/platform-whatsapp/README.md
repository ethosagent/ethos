# @ethosagent/platform-whatsapp

## Purpose

WhatsApp `PlatformAdapter` for Ethos. It links to a real WhatsApp account as a device through the unofficial WhatsApp Web multi-device protocol (Baileys), with no tokens, Business API or public URL. This is not the official Business API: heavy automation can get a number banned, see the responsible-use note in [docs/setup.md](docs/setup.md).

## Public surface

Exported from `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `WhatsAppAdapter` | class | `PlatformAdapter` + `VoiceOutboundAdapter` for one linked account. |
| `WhatsAppAdapterConfig` | type | Constructor options. |
| `resolveWaWebVersion` | function | Looks up the current WA Web version, falling back to Baileys' default. |

Subpath exports (`package.json` `exports`): `./clarify-surface` (`WhatsAppClarifySurface`), `./format` (`platformPrompt`).

## Seam

Implements `PlatformAdapter` from `@ethosagent/types` (checked by `implements` on `WhatsAppAdapter` in `src/index.ts`). Archcheck layer: `extensions`. The WA Web version fallback is pinned by `src/__tests__/wa-version.test.ts`.

## More

- [docs/setup.md](docs/setup.md): what you can do, responsible use, pairing quickstart.
- [docs/operations.md](docs/operations.md): reply modes, allowlisting, multiple bots, state, troubleshooting.
- [docs/internals.md](docs/internals.md): pairing, botKey derivation, media, receipt reactions, file table.

## Testing

```
pnpm vitest run extensions/platform-whatsapp
```

Pinning tests in `src/__tests__/`: `channel-mode.test.ts`, `deny-unknown.test.ts` (allowlist gate), `message-parser.test.ts`, `session-store.test.ts`, `wa-version.test.ts`, `inbound-media-cap.test.ts`.
