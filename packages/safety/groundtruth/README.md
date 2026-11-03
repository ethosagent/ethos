# @ethosagent/safety-groundtruth

## Purpose

Checks whether what the agent said matches what its tools did. An evidence collector fills a per-turn ledger from tool results, a claims auditor holds the final reply against that ledger, and a check-line parser reads explicit ground-truth checks. Verdicts are `CONTRADICTED` or `UNSUPPORTED`.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `createEvidenceCollector` | function | `after_tool_call` handler that records tool evidence. |
| `EvidenceCollectorOptions` | type | Options for the collector. |
| `LedgerStore` | class | Per-turn evidence ledger. |
| `LedgerStoreOptions` | type | Options for `LedgerStore`. |
| `createLedgerReset` | function | `session_start` handler that makes the ledger per-turn. |
| `EvidenceRecord` | type | One piece of evidence. |
| `EvidenceKind` | type | Kind of evidence. |
| `createClaimsAuditor` | function | Builds the turn auditor. |
| `ClaimsAuditorOptions` | type | Options for the auditor. |
| `formatGroundingMessage` | function | Renders verdicts as a user-visible message. |
| `Verdict` | type | An auditor verdict. |
| `CONTRADICTED` | const | Verdict code for a claim the evidence contradicts. |
| `UNSUPPORTED` | const | Verdict code for a claim with no evidence. |
| `NO_TOOLS_AT_ALL` | const | Code for a reply that claims work with no tool calls. |
| `extractClaims` | function | Extracts claims from a sentence. |
| `extractAuditableSentences` | function | Selects the sentences worth auditing. |
| `ExtractedClaim` | type | One extracted claim. |
| `AuditableSentence` | type | One auditable sentence. |
| `ClaimCode` | type | Claim category. |
| `SentenceSplitter` | type | Splitter function type. |
| `parseChecks` | function | Parses ground-truth check lines. |
| `isCheckLine` | function | Whether a line is a check line. |
| `GroundTruthCheck` | type | One parsed check. |
| `ParsedChecks` | type | Result of `parseChecks`. |
| `GROUNDING_TOOL_NAME` | const | Name of the grounding tool. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`); depends on `@ethosagent/types` only. The auditor is a `TurnAuditor` (see the `@ethosagent/types` contracts). Precision of user-visible verdicts is pinned by `src/__tests__/corpus.test.ts`; no static rule enforces that the auditor is wired (limitation).

## Testing

```
pnpm vitest run packages/safety/groundtruth
```

- `src/__tests__/corpus.test.ts`: precision of at least 0.95 on user-visible verdicts over a labelled corpus.
- `src/__tests__/auditor.test.ts`: supported claims stay silent, contradicted claims are named.
- `src/__tests__/evidence.test.ts`: evidence recorded from tool results.
- `src/__tests__/extraction.test.ts`: pre-filter drops code blocks and quotes.
- `src/__tests__/checks.test.ts`: check-line parsing.
