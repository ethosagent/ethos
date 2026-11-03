# @ethosagent/safety-injection

## Purpose

The prompt-injection defense primitives: wrapping untrusted tool output in `<untrusted>` blocks, stripping chat-template tokens, a pattern check and an LLM classifier for suspicious text, the system-prompt prelude that teaches the model about untrusted blocks, and the default set of tools downgraded after an untrusted read.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `wrapUntrusted` | function | Wraps outside content in a tagged untrusted block. |
| `WrapInput` | type | Input to `wrapUntrusted`. |
| `WrapResult` | type | Result of `wrapUntrusted`. |
| `sanitizeTemplateTokens` | function | Strips chat-template tokens from text. |
| `STRIPPED_PLACEHOLDER` | const | Replacement text for stripped tokens. |
| `SanitizeResult` | type | Result of `sanitizeTemplateTokens`. |
| `sanitize` | function | Strips lines containing injection patterns from injected content. |
| `shortPatternCheck` | function | Pattern check for short inputs. |
| `c2PatternCheck` | function | Pattern check for C2-style text. |
| `C2_PATTERNS` | const | The C2 pattern list. |
| `PatternCheckResult` | type | Result of a pattern check. |
| `PatternHit` | type | One pattern hit. |
| `createLLMClassifier` | function | LLM-backed injection classifier. |
| `InjectionClassifier` | type | Classifier interface. |
| `InjectionVerdict` | type | Classifier verdict. |
| `resolveDowngradedTools` | function | Resolves the tool set blocked after an untrusted read. |
| `DOWNGRADE_REJECTION_MESSAGE` | const | Message returned for a downgraded call. |
| `INJECTION_DEFENSE_PRELUDE` | const | System-prompt prelude. |
| `INJECTION_DEFENSE_PRELUDE_COMPACT` | const | Compact form of the prelude. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`); depends on `@ethosagent/types` only. It backs ARCHITECTURE.md §V S6 (inbound text passes safety injection), which is enforced by `packages/types/src/__tests__/personality-field-count.test.ts` and `packages/core/src/__tests__/safety-conformance.test.ts`. The tests below pin this package's own behaviour.

## Testing

```
pnpm vitest run packages/safety/injection
```

- `src/__tests__/wrap.test.ts`: untrusted wrapping, `unknown` source fallback, tokens sanitized inside the wrapper.
- `src/__tests__/sanitize.test.ts`: ChatML, `[INST]` and `<<SYS>>` markers stripped.
- `src/__tests__/pattern-check.test.ts`: instruction-override phrases flagged.
- `src/__tests__/classifier.test.ts`: verdict parsing and fallback to the pattern check.
- `src/__tests__/downgrade.test.ts`: default downgraded tool set.
