import { defineArchitecture } from 'archcheck';

// Ethos architecture manifest for archcheck — the enforced projection of ARCHITECTURE.md §II
// (layers) and §III (laws). ARCHITECTURE.md says why each law exists; this file is the only place
// the layer paths, the app entry modules, the vendored shim and the exceptions to these rules
// live (they moved here from .architecture-state.yaml). Changing a rule, an exception or the
// baseline needs the maintainer's approval (ARCHITECTURE.md §IX, CLAUDE.md "Architecture checks").
//
// Layer matching is first-match-wins, so narrow layers (tests, app entry modules,
// observability-sqlite, web-api rpc) are declared BEFORE the broad ones they sit inside.
//
// Not covered: apps/web, apps/desktop and apps/vscode-extension are excluded from the root
// tsconfig.json that archcheck reads, so no rule here sees them.

const law = {
  kind: 'layers' as const,
  severity: 'error' as const,
  confidence: 'deterministic' as const,
};

const TEST_GLOBS = ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'];
const NOT_TESTS = TEST_GLOBS.map((glob) => `!${glob}`);
const ALL_SOURCE = ['packages/**', 'extensions/**', 'apps/**'];

export default defineArchitecture({
  // `archcheck emit` writes its rule table into the fenced region of ARCHITECTURE.md §IX and its
  // editor/graph configs under .archcheck/generated/; `archcheck emit --check` fails when either
  // is stale.
  docs: ['ARCHITECTURE.md'],
  generatedDir: '.archcheck/generated',
  rules: [
    // ---- Layers (narrow first) -------------------------------------------------------------
    {
      ...law,
      id: 'tests-reach-anything',
      statement: 'test files may import any layer to build fixtures',
      // vitest.config.ts is test tooling; without it here it is the one unlayered file in the repo.
      params: { name: 'tests', match: [...TEST_GLOBS, 'vitest.config.ts'], mayImport: '*' },
      remedy: { summary: 'keep production code out of __tests__ and *.test.ts files' },
    },
    {
      ...law,
      id: 'app-entry-modules-compose',
      statement: 'an app entry module is its thin wiring adapter and may compose anything (§II)',
      params: {
        name: 'app-entry',
        match: [
          'apps/acp-server/src/index.ts',
          'apps/desktop/src/main/index.ts',
          'apps/desktop/src/main/serve.ts',
          'apps/ethos/src/index.ts',
          'apps/ethos/src/wiring.ts',
          'apps/ethos/src/lib/acp-mcp-wiring.ts',
          'apps/mcp-server/src/index.ts',
          'apps/tui/src/index.ts',
          'apps/tui/src/setup/index.ts',
          'apps/web-api/src/index.ts',
        ],
        mayImport: '*',
      },
      // The module each app's package.json names as its entry point, plus the app's dedicated
      // wiring adapter where one exists by name (apps/ethos/src/wiring.ts is the archetype;
      // apps/desktop/src/main/serve.ts is the desktop's in-process backend root;
      // apps/ethos/src/lib/acp-mcp-wiring.ts binds McpSessionView into acp-server's seam).
      // Listing a file is a claim that it IS a composition root, never a way to silence a finding:
      // apps/ethos/src/commands/* are NOT composition roots — they reach implementations through
      // wiring, and the ones that do not yet are l5-apps-through-wiring baseline debt.
      remedy: {
        summary: 'list a file here only if it IS a composition root, never to silence a finding',
      },
    },
    {
      ...law,
      id: 'observability-sqlite-stays-extractable',
      statement:
        'observability-sqlite depends only on types, safety-redact and the sqlite shim, so it stays extractable',
      params: {
        name: 'observability-sqlite',
        match: 'extensions/observability-sqlite/src/**',
        mayImport: ['contracts', 'vendored', 'security-kernel'],
      },
      remedy: { summary: 'take the dependency as an injected contract from @ethosagent/types' },
    },
    {
      ...law,
      id: 'web-api-rpc-is-thin',
      statement:
        'web-api rpc handlers validate input, call one service method and return its result',
      params: {
        name: 'web-api-rpc',
        match: 'apps/web-api/src/rpc/**',
        mayImport: ['contracts', 'support', 'wiring', 'apps'],
      },
      remedy: { summary: 'move data access into a repository or service under apps/web-api/src' },
    },
    {
      ...law,
      id: 'l1-contracts-pure',
      statement: '@ethosagent/types has zero imports and zero deps (§II L1)',
      params: { name: 'contracts', match: 'packages/types/src/**', mayImport: [] },
      remedy: { summary: 'move the shared type into @ethosagent/types, or stop sharing it' },
    },
    {
      // packages/sqlite is a synchronous shim over node:sqlite with no Ethos semantics (no
      // contract, no policy, no boundary decision); its one internal edge is to @ethosagent/types
      // for EthosError. It is a workspace package only so it can be patched in the same commit as
      // its caller. The bar for joining this layer is "no Ethos semantics", not "low-level".
      ...law,
      id: 'vendored-shim',
      statement: 'the sqlite shim is a thin platform wrapper with no Ethos semantics',
      params: { name: 'vendored', match: 'packages/sqlite/src/**', mayImport: ['contracts'] },
      remedy: { summary: 'keep Ethos semantics out of the shim; put them in its caller' },
    },
    {
      ...law,
      id: 'kernel-reads-contracts',
      statement: 'the security kernel depends only on contracts and vendored shims',
      params: {
        name: 'security-kernel',
        match: ['packages/safety/*/src/**', 'packages/storage-fs/src/**'],
        mayImport: ['contracts', 'vendored'],
      },
      remedy: { summary: 'take the dependency through a contract in @ethosagent/types' },
    },
    {
      // archcheck cannot say "type-only toward the kernel"; every core -> kernel edge is allowed.
      ...law,
      id: 'l2-core-no-concrete',
      statement: 'core never imports concrete implementations (§II L2)',
      params: {
        name: 'core',
        match: 'packages/core/src/**',
        mayImport: ['contracts', 'security-kernel'],
      },
      remedy: { summary: 'receive the implementation through AgentLoopConfig injection' },
    },
    {
      ...law,
      id: 'extensions-implement-contracts',
      statement: 'an extension implements contracts and never reaches wiring or apps',
      params: {
        name: 'extensions',
        match: 'extensions/*/src/**',
        // observability-sqlite is itself an extension, and §IX permits sibling extension deps
        // (export-langfuse declares it in package.json). core-adapters: plugin-sdk is the plugin
        // contract (EthosPluginApi, LLMProviderFactory) every first-party plugin registers through.
        mayImport: [
          'contracts',
          'security-kernel',
          'core',
          'vendored',
          'support',
          'core-adapters',
          'observability-sqlite',
        ],
      },
      remedy: { summary: 'depend on the contract in @ethosagent/types; let wiring compose' },
    },
    {
      ...law,
      id: 'l3-wiring-composes',
      statement: 'wiring is the composition root and may import every layer',
      params: {
        name: 'wiring',
        match: 'packages/wiring/src/**',
        mayImport: '*',
        catchesUnlayered: true,
      },
      remedy: { summary: 'declare a layer for the new folder in architecture.config.ts' },
    },
    {
      // Declared before `support` (first match wins): these two packages exist to wrap core's
      // class API. plugin-sdk re-exports ContextStore and builds a real AgentLoop test harness for
      // plugin authors (src/testing.ts); agent-bridge adapts AgentLoop's async-generator stream
      // into an EventEmitter every UI surface subscribes to.
      ...law,
      id: 'core-adapters-wrap-core',
      statement:
        'plugin-sdk and agent-bridge wrap core for plugin authors and UI surfaces, and reach nothing concrete',
      params: {
        name: 'core-adapters',
        match: ['packages/plugin-sdk/src/**', 'packages/agent-bridge/src/**'],
        mayImport: ['contracts', 'security-kernel', 'vendored', 'core', 'support'],
      },
      remedy: { summary: 'take the implementation through a contract; let wiring compose it' },
    },
    {
      ...law,
      id: 'support-packages',
      statement: 'library packages depend only on contracts, the kernel and vendored shims',
      params: {
        name: 'support',
        match: 'packages/*/src/**',
        mayImport: ['contracts', 'security-kernel', 'vendored'],
      },
      remedy: { summary: 'take the dependency through a contract, or move the code into wiring' },
    },
    {
      ...law,
      id: 'l5-apps-through-wiring',
      statement:
        'apps depend on contracts and wiring only; concrete implementations come via wiring (Law 5)',
      params: {
        name: 'apps',
        match: 'apps/*/src/**',
        // app-entry: an app reaches its own wiring.ts / index.ts, and one app may compose another
        // app's entry (ethos -> @ethosagent/web-api). web-api-rpc: web-api features/*/rpc and
        // routes import rpc/context and rpc/router. Both are the app's own internals, not Law 5.
        // core-adapters: surfaces drive a loop through agent-bridge (apps/ethos chat's
        // InMemorySteerSink, web-api's chat service), which is a surface adapter, not an extension.
        mayImport: [
          'contracts',
          'wiring',
          'support',
          'vendored',
          'core-adapters',
          'app-entry',
          'web-api-rpc',
        ],
        // Law 5 is about runtime coupling, so type-only imports are exempt.
        ignoreTypeOnly: true,
      },
      remedy: { summary: 'reach the implementation through @ethosagent/wiring' },
    },

    // ---- Banned syntax ---------------------------------------------------------------------
    {
      id: 'l10-silent-libraries',
      kind: 'banned-syntax',
      statement: 'library code does not write to the console (Law 10)',
      severity: 'error',
      confidence: 'deterministic',
      params: {
        appliesTo: ['packages/**', 'extensions/**', ...NOT_TESTS],
        selector: 'member-access',
        target: 'console',
      },
      remedy: { summary: 'use the injected Logger; only apps/ethos/src may print' },
    },
    {
      id: 'p24-no-fsstorage-in-libraries',
      kind: 'banned-syntax',
      statement: 'library code receives an injected Storage and never constructs FsStorage (P2.4)',
      severity: 'error',
      confidence: 'deterministic',
      params: {
        appliesTo: [
          'extensions/**',
          'apps/web-api/src/repositories/**',
          'apps/web-api/src/services/**',
          ...NOT_TESTS,
        ],
        selector: 'new-expression',
        target: 'FsStorage',
      },
      remedy: { summary: 'thread the Storage from the composition root (wiring / app entry)' },
    },
    {
      id: 'surface-throws-ethos-error',
      kind: 'banned-syntax',
      statement: 'CLI surface code throws EthosError, not raw Error (Phase 30.9)',
      severity: 'error',
      confidence: 'proxy',
      params: {
        appliesTo: ['apps/ethos/src/commands/**', ...NOT_TESTS],
        selector: 'new-expression',
        target: 'Error',
      },
      remedy: { summary: 'throw new EthosError({ code, cause, action })' },
    },
    {
      id: 'tools-read-env-through-ctx',
      kind: 'banned-syntax',
      statement: 'tool code reads configuration through ctx.*, not process.env',
      severity: 'error',
      confidence: 'proxy',
      params: {
        appliesTo: [
          'extensions/tools-*/src/**',
          '!extensions/tools-process/src/spawn.ts',
          '!extensions/tools-process/src/operations.ts',
          '!extensions/tools-process/src/registry.ts',
          '!extensions/tools-process/src/watcher.ts',
          '!extensions/tools-browser/src/sessions.ts',
          ...NOT_TESTS,
        ],
        selector: 'member-access',
        target: 'process.env',
      },
      remedy: { summary: 'use ctx.secrets / ctx.process; boot checks belong in isAvailable()' },
    },
    {
      id: 'no-computed-dynamic-import',
      kind: 'banned-syntax',
      statement: 'dynamic imports name a literal specifier so the graph stays readable',
      severity: 'error',
      confidence: 'deterministic',
      params: { appliesTo: [...ALL_SOURCE, ...NOT_TESTS], selector: 'computed-dynamic-import' },
      remedy: { summary: 'import a literal specifier, or register the module in a table' },
    },
    {
      id: 'no-empty-catch',
      kind: 'banned-syntax',
      statement: 'a catch block handles, rethrows or explains the error it swallows',
      severity: 'error',
      confidence: 'deterministic',
      params: { appliesTo: [...ALL_SOURCE, ...NOT_TESTS], selector: 'empty-catch' },
      remedy: { summary: 'log, rethrow, or comment why the failure is safe to ignore' },
    },
    {
      id: 'no-inline-suppression',
      kind: 'banned-syntax',
      statement: 'exceptions live in the manifest with an owner and an expiry, not inline',
      severity: 'warn',
      confidence: 'deterministic',
      params: { appliesTo: [...ALL_SOURCE, ...NOT_TESTS], selector: 'suppression-comment' },
      remedy: { summary: 'fix the code, or record an exception in architecture.config.ts' },
    },

    // ---- Structure -------------------------------------------------------------------------
    {
      id: 'every-error-rule-has-a-fixture',
      kind: 'required-file',
      statement: 'every error-severity rule has a fixture it catches',
      severity: 'error',
      confidence: 'deterministic',
      params: {
        forEach: 'rule[severity=error]',
        expect: 'archcheck-fixtures/{id}.violation.ts',
      },
      remedy: { summary: 'add a file that deliberately breaks this rule' },
    },
  ],
  exceptions: [
    // Every entry follows ARCHITECTURE.md §VIII: one exact file per entry (never a glob), `expires`
    // is the entry's review_by, and `reason` carries the id, the law suspended, created, why, the
    // code that justifies it, and an observable removal condition. archcheck has no fields for
    // id/law/created/removal_condition, so they live in the reason text. Exceptions to rules
    // archcheck enforces live HERE only; .architecture-state.yaml holds none of them.
    {
      rule: 'l5-apps-through-wiring',
      path: 'apps/ethos/src/redact-error.ts',
      owner: '@MiteshSharma',
      expires: '2027-02-12',
      reason:
        'EX-001 (§III Law 5, created 2026-08-12): the crash logger imports @ethosagent/safety-redact ' +
        'directly because it runs on the bootstrap path BEFORE wiring exists and must stay ' +
        'synchronous (it finishes writing before the process exits). Routing it through wiring ' +
        'measured 121 ms against 18 ms direct, paid on every CLI start for a path that runs only ' +
        'when the process is dying; dropping redaction is not available because a crash log is ' +
        'where an unredacted credential ends up. Removal condition: redact-error.ts no longer ' +
        'imports @ethosagent/safety-redact (redaction dropped or inlined into apps/ethos) and this ' +
        'rule reports nothing for the file with this entry removed.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'packages/logger/src/index.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-002 (§III Law 10, created 2026-09-26): ConsoleLogger.emit IS the console sink every ' +
        'Logger falls back to — the console.error/warn/debug/log calls in ConsoleLogger.emit are ' +
        'the only place a Logger record reaches the terminal, so there is nothing to inject in ' +
        'their place. Removal condition: packages/logger/src/index.ts has no console.* member ' +
        'access (the console sink moves into apps/ethos/src) and this rule reports nothing for ' +
        'the file with this entry removed.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'packages/wiring/src/build-context.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-003 (§III Law 10, created 2026-09-26): buildWiringContext is the composition root. ' +
        'When config.storage.encryption is set without ETHOS_STORAGE_KEY it prints why and calls ' +
        'process.exit(1); the injected logger defaults to noopLogger there, so a Logger call ' +
        'would exit the process with no explanation. Removal condition: that branch throws an ' +
        'EthosError the app entry prints instead of calling console.error + process.exit, and ' +
        'this rule reports nothing for the file with this entry removed.',
    },
    {
      rule: 'tools-read-env-through-ctx',
      path: 'extensions/tools-web/src/search-backends.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-004 (tool config through ctx, created 2026-09-26): every process.env read in this ' +
        'file is inside a backend isAvailable() (exaBackend, tavilyBackend, braveBackend), which ' +
        'runs at boot when no ToolContext exists; search() itself reads the key through ' +
        'ctx.secretsResolver. scripts/check-tool-imports.sh skips isAvailable bodies for the same ' +
        'reason. Removal condition: isAvailable() takes its answer from an injected secrets ' +
        'resolver (no process.env in the file) and this rule reports nothing for the file with ' +
        'this entry removed.',
    },
    {
      rule: 'no-computed-dynamic-import',
      path: 'extensions/plugin-loader/src/index.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-005 (dynamic-import literal specifier, created 2026-09-26): loading a plugin IS ' +
        'importing a path that is data — `await import(entry)` in loadFromPluginDir (entry from ' +
        'resolveEntry) and in the node_modules scan (entry from resolveNpmEntry), each only after ' +
        'the safety scan (canInstall) allowed it. No literal specifier or static table can name ' +
        'a plugin an operator installs later. Removal condition: plugin modules load through a ' +
        'dedicated loader seam outside this file (e.g. a worker/sandbox host) so the file has no ' +
        'computed import(), and this rule reports nothing for it with this entry removed.',
    },
    {
      rule: 'support-packages',
      path: 'packages/config/src/index.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-006 (§II layer direction, created 2026-09-26): config imports deriveBotKey from ' +
        '@ethosagent/core (packages/core/src/bot-key.ts) so a configured bot and the adapter that ' +
        'stamps InboundMessage.botKey derive the same key. It cannot move into @ethosagent/types ' +
        '(it uses node:crypto, and types has zero deps — Law 1), and a copy in config would break ' +
        'the single-owner rule bot-key.ts states ("two sources of truth for the algorithm means ' +
        'two sources of divergence"). Removal condition: deriveBotKey lives in a layer both core ' +
        'and config may import, config no longer imports @ethosagent/core, and this rule reports ' +
        'nothing for the file with this entry removed.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'extensions/skill-evolver/src/evolve-helpers.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-007 (§III Law 10, created 2026-09-26): this file is the body of the `ethos evolve ' +
        'status|apply|prune|archive` CLI subcommands (runEvolveStatus, runEvolveApply, ...), called ' +
        'only from apps/ethos/src/commands/evolve.ts; its console output IS the user-facing command ' +
        'output, not library logging. Removal condition: the command bodies move into ' +
        'apps/ethos/src/commands/ (or print through a writer the command passes in) and this rule ' +
        'reports nothing for the file with this entry removed.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'extensions/platform-callcapture/src/detect-cli.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-008 (§III Law 10, created 2026-09-26): the Phase 1 manual-verification CLI, run by a ' +
        'human via `pnpm --filter @ethosagent/platform-callcapture exec tsx src/detect-cli.ts` to ' +
        'eyeball detector events; nothing imports it, so its console output reaches no embedder. ' +
        'Removal condition: the file is moved out of src/ (e.g. to a scripts/ folder outside the ' +
        'extensions/*/src/** layer) or deleted.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'extensions/platform-callcapture/src/phase2-cli.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-009 (§III Law 10, created 2026-09-26): the Phase 2 manual-verification CLI (detector + ' +
        'notification gate), run by a human via `pnpm --filter @ethosagent/platform-callcapture ' +
        'exec tsx src/phase2-cli.ts`; nothing imports it. Removal condition: the file is moved out ' +
        'of src/ or deleted.',
    },
    {
      rule: 'l10-silent-libraries',
      path: 'extensions/platform-callcapture/src/phase3-cli.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-010 (§III Law 10, created 2026-09-26): the Phase 3 manual-verification CLI (tap + mic ' +
        'capture, prints the merged transcript), run by a human via `pnpm --filter ' +
        '@ethosagent/platform-callcapture exec tsx src/phase3-cli.ts`; nothing imports it. Removal ' +
        'condition: the file is moved out of src/ or deleted.',
    },
    {
      rule: 'tools-read-env-through-ctx',
      path: 'extensions/tools-browser/src/launch-options.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-011 (tool config through ctx, created 2026-09-26): hasDisplay, resolveHeadless and ' +
        'buildLaunchOptions decide headed-vs-headless at Chromium launch, where no ToolContext ' +
        'exists; each `process.env` is only the DEFAULT of an injectable `env` parameter, which is ' +
        'how the tests drive them. Removal condition: callers pass the environment explicitly and ' +
        'the parameters lose their process.env default, so this rule reports nothing for the file ' +
        'with this entry removed.',
    },
    {
      rule: 'tools-read-env-through-ctx',
      path: 'extensions/tools-file/src/index.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-012 (tool config through ctx, created 2026-09-26): isPersonalityDefinitionPath reads ' +
        'ETHOS_STATE_DIR so its defence-in-depth refusal covers the same state dir ethosDir() in ' +
        '@ethosagent/config honours (the enforcer is ScopedFsImpl.checkReach writeDenyPaths in ' +
        'packages/core/src/scoped/scoped-fs.ts). ToolContext has no state-dir field, and its ' +
        'fields are pinned by packages/types/src/__tests__/tool-context-fields.test.ts. Removal ' +
        'condition: the state dir reaches the tool through ctx (or the tool factory), the file has ' +
        'no process.env read, and this rule reports nothing for it with this entry removed.',
    },
    {
      rule: 'tools-read-env-through-ctx',
      path: 'extensions/tools-image/src/providers/openai-dalle.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-013 (tool config through ctx, created 2026-09-26): the only process.env read is ' +
        'OPENAI_API_KEY inside OpenAIDalleProvider.isAvailable(), a boot-time availability check ' +
        'with no ToolContext; generate() takes its key from opts.apiKey or the constructor. Same ' +
        'shape as EX-004. Removal condition: isAvailable() answers from an injected key or ' +
        'secrets resolver, and this rule reports nothing for the file with this entry removed.',
    },
    {
      rule: 'tools-read-env-through-ctx',
      path: 'extensions/tools-image/src/providers/replicate-flux.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-014 (tool config through ctx, created 2026-09-26): the only process.env read is ' +
        'REPLICATE_API_TOKEN inside ReplicateFluxProvider.isAvailable(), a boot-time availability ' +
        'check with no ToolContext; generation takes its key from opts or the constructor. Same ' +
        'shape as EX-004. Removal condition: isAvailable() answers from an injected key or ' +
        'secrets resolver, and this rule reports nothing for the file with this entry removed.',
    },
    {
      rule: 'no-computed-dynamic-import',
      path: 'apps/ethos/src/commands/doctor.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-015 (dynamic-import literal specifier, created 2026-09-26): checkSdk(modulePath) ' +
        'probes whether each optional SDK in the CORE_SDKS / CHANNEL_SDKS tables resolves; the ' +
        'specifiers ARE a static table in the same file. Literal imports per row do not typecheck: ' +
        "import('nodemailer') fails tsc with TS7016 because apps/ethos has no @types/nodemailer. " +
        'Removal condition: each row carries a literal `() => import(...)` loader (types permitting) ' +
        'so checkSdk has no computed import(), and this rule reports nothing for the file with this ' +
        'entry removed.',
    },
    {
      rule: 'no-computed-dynamic-import',
      path: 'apps/ethos/src/livekit-media.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-016 (dynamic-import literal specifier, created 2026-09-26): resolveLiveKitMedia loads ' +
        'the native @livekit/rtc-node binding (the RTC_NODE constant) through an injectable ' +
        'importModule seam; the package is deliberately undeclared (never a static dependency, ' +
        'loaded only when telephony is configured), so a literal specifier would make tsc demand ' +
        'types for a module that is not installed. Removal condition: @livekit/rtc-node becomes a ' +
        'declared (optional) dependency imported by literal specifier, and this rule reports ' +
        'nothing for the file with this entry removed.',
    },
    {
      rule: 'no-computed-dynamic-import',
      path: 'extensions/voice-satellite/src/engines/sherpa-wake-engine.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-017 (dynamic-import literal specifier, created 2026-09-26): loadSherpa imports ' +
        'SHERPA_PACKAGE (sherpa-onnx-node) through a string-typed local because the package is an ' +
        'optional per-architecture native peer intentionally absent from this repo; a literal ' +
        'would make tsc demand types for a module nobody installed (the comment at the call site ' +
        'says so). Removal condition: sherpa-onnx-node is declared as an optional dependency with ' +
        'types and imported by literal specifier, and this rule reports nothing for the file with ' +
        'this entry removed.',
    },
    {
      rule: 'surface-throws-ethos-error',
      path: 'apps/ethos/src/commands/gateway.ts',
      owner: '@MiteshSharma',
      expires: '2027-03-26',
      reason:
        'EX-018 (Phase 30.9 EthosError at the CLI surface, created 2026-09-26): the one raw Error ' +
        "is `reject(new Error('health check timeout'))` inside withTimeout, whose rejection is " +
        'consumed only by Promise.allSettled in buildGatewayHeartbeat and turned into an adapter ' +
        '`ok: false` flag — it is never thrown to or shown to a user. The rule is a proxy (any ' +
        '`new Error` in commands/), and this is its false positive. Removal condition: withTimeout ' +
        'rejects with an EthosError (or moves out of apps/ethos/src/commands/) and this rule ' +
        'reports nothing for the file with this entry removed.',
    },
  ],
});
