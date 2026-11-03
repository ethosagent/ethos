# @ethosagent/voice-text

## Purpose

The one speakable-text implementation: a sanitizer that makes text fit for speech, a Unicode-aware sentence splitter and chunker, a transcript hallucination filter, wake-phrase matching, and the voice-reply decision. It is pure text in, text out, with no external runtime dependencies.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `sanitizeForSpeech` | function | Rewrites text into something a TTS voice can say. |
| `splitSentences` | function | Unicode-aware sentence splitter. |
| `SplitSentencesOptions` | type | Options for `splitSentences`. |
| `SentenceSplit` | type | One split result. |
| `DEFAULT_SOFT_BREAK_CHARS` | const | Default soft-break characters for the splitter. |
| `SentenceChunker` | class | Incremental chunker over a streamed text. |
| `truncateAtSentenceBoundary` | function | Truncates text at a sentence boundary. |
| `isHallucination` | function | Flags known transcript hallucinations. |
| `detectLanguage` | function | Detects the language of a text. |
| `DetectLanguageOptions` | type | Options for `detectLanguage`. |
| `shouldReplyWithVoice` | function | Decides whether a reply goes out as voice. |
| `VoiceReplyDecisionInput` | type | Input to `shouldReplyWithVoice`. |
| `VoiceMode` | type | The voice-mode setting. |
| `DEFAULT_VOICE_MODE` | const | Default voice mode. |
| `matchWakePhrase` | function | Matches an utterance against wake phrases. |
| `stripWakePhrase` | function | Removes a matched wake phrase from an utterance. |
| `normalizeUtterance` | function | Normalizes an utterance for matching. |
| `boundedLevenshtein` | function | Edit distance with an upper bound. |
| `wakePhraseKey` | function | Stable key for a wake phrase. |
| `DEFAULT_WAKE_SENSITIVITY` | const | Default wake-match sensitivity. |
| `WakePhrase` | type | A configured wake phrase. |
| `WakePhraseMatch` | type | Result of a wake-phrase match. |

## Seam

Support-layer package (see `architecture.config.ts`). It imports only the contracts package; `VoiceMode` comes from `@ethosagent/types`. The single-implementation rule (the speakable-text functions are declared once, here, and the package depends on nothing but contracts) is pinned by `src/__tests__/drift-gate.test.ts`.

## Testing

```
pnpm vitest run packages/voice-text
```

- `src/__tests__/drift-gate.test.ts`: the speakable-text functions are declared once, here; the package imports and depends on nothing but contracts.
- `src/__tests__/sanitize.test.ts`: `sanitizeForSpeech` behaviour.
- `src/__tests__/split-sentences.test.ts`: sentence splitting.
- `src/__tests__/hallucination.test.ts`: `isHallucination`.
- `src/__tests__/voice-mode.test.ts`: `shouldReplyWithVoice`.
- `src/__tests__/wake-match.test.ts`: wake-phrase matching.
- `src/__tests__/detect-language.test.ts`: `detectLanguage`.
