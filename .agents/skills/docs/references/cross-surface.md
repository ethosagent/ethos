
Same content, different surfaces. Single source of truth is the markdown under [docs/content/](../../../docs/content/).

| Surface | What it shows | Render rule |
|---|---|---|
| **Docusaurus site** (primary) | Full tree, all kinds, full styling | The canonical surface. Other surfaces link back here. |
| **Repo [README.md](../../../README.md)** | Standalone-readable surface for users who may never click through. Marketing voice welcome; value-first opening required. Includes install, getting started, surface comparison, migration. | Treat as its own artifact, not as a docs index. Sections that overlap docs (Getting started, CLI vs chat, migration walkthroughs) are intentional — duplication is the feature here, not a bug. The reader of `README.md` may never see the docs site; they should still understand most of the product. |
| **In-package READMEs** | One-sentence purpose · install · link to package's reference page | One paragraph max. Package metadata, not docs. |
| **`docs/static/llms.txt`** | Glossary · CLI reference · interface reference · explanation pages | Generated at build time from pages with `agent: true` front-matter flag (or by kind: reference + explanation). Single text file, no nav. |
| **Personality `ETHOS.md`** | First-person identity for the personality itself | Not user docs — runtime config the agent reads. First-person, imperative, terminal-adjacent. **Not a marketing surface** (the LLM reads this at runtime; advocacy doesn't help there). See the ETHOS.md row in [Voice mode by page kind](#voice-mode-by-page-kind). |
| **`apps/web` in-app help** | Glossary tooltips, command-palette descriptions | Reads from canonical glossary entries. Sentence-length cap: 140 chars. |

