
Each kind of reference page follows a fixed schema. Schemas exist so the reader's eye knows where to look, page after page.

### CLI subcommand reference

```
## ethos <subcommand>

Synopsis · one-line description · since version
| Arg / flag | Type | Default | Description |
Examples · 1–3 minimal invocations
Exit codes · table of (code, meaning)
See also · related subcommands
```

### Config field reference (`config-yaml.md`, `personality-yaml.md`)

```
## <field-name>

Type · Default · Required · Since version
Description (1 paragraph max)
Example (1 minimal YAML block)
Notes (only if non-obvious behavior; one bullet per note)
```

### Interface reference (`AgentEvent`, `Tool`, `LLMProvider`, etc.)

```
## <InterfaceName>

Source · link to packages/types/src/<file>
Signature · TypeScript block, verbatim from source
Members · table of (name, type, description)
Notes · one bullet per non-obvious invariant
Used by · table of (consumer file, role)
See also · related interfaces
```

**Reference depth rules (apply to all reference schemas):**
1. **Constraints live in the description, in prose.** "Max 50; values above are clamped." "Only honored when `approvalMode: smart`." "Mutually exclusive with `model`." A type column without constraints is half a reference.
2. **Every enum value gets a one-line meaning, with the default marked.** Not `mode: 'keyword' | 'semantic' | 'hybrid'` alone — a list: `keyword` — FTS5 match (default); `semantic` — embedding similarity; `hybrid` — both, merged by score.
3. **Reference ↔ guide cross-links run both directions.** A parameter description links to the explanation/how-to that uses it ("see [approval gates](../how-to/set-up-approval-gates.md)"); the guide links back to the parameter's anchor. The reference answers "what"; one click answers "when and why".

### Error / troubleshooting entry

```
## <Error message or symptom>

Cause · 1–2 sentences
Fix · numbered steps (≤5)
Prevent · 1 bullet (optional)
```

