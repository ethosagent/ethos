import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Option C — refined classic (user-approved 2026-09-26; mockup
// ethos-docs-c-classic.html). Four static top-level groups, each carrying a
// `sidebar-group` className that custom.css styles as an uppercase label with
// a colored dot (researcher / engineer / reviewer / neutral). The flat how-to
// list is regrouped into collapsed topical subcategories; every page id that
// was reachable before stays reachable here.
/** A page split into subpages: the index doc is the category link.
 * Parts are id suffixes: '/x' or '-2-x'. */
const splitDoc = (id: string, label: string, parts: string[]) => ({
  type: 'category' as const,
  label,
  collapsed: true,
  link: { type: 'doc' as const, id },
  items: parts.map((part) => `${id}${part}`),
});

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting started',
      collapsible: false,
      className: 'sidebar-group sidebar-group--start',
      items: [
        'intro',
        'getting-started/what-is-ethos',
        splitDoc(
          'getting-started/architecture-90-seconds',
          'What does Ethos look like in 90 seconds?',
          ['/surfaces-and-events'],
        ),
        'getting-started/why-ethos',
        'getting-started/glossary',
      ],
    },
    {
      type: 'category',
      label: 'Using Ethos',
      collapsible: false,
      className: 'sidebar-group sidebar-group--using',
      items: [
        splitDoc('using/quickstart', 'Quickstart', ['-2-first-message']),
        {
          type: 'category',
          label: 'Tutorials',
          collapsed: true,
          items: [
            splitDoc('using/tutorials/first-agent', 'Build your first agent', [
              '-2-sessions-and-personalities',
            ]),
            splitDoc('using/tutorials/first-personality', 'Create your first personality', [
              '-2-switch-and-isolate',
              '-3-duplicate-and-patterns',
            ]),
            splitDoc('using/tutorials/first-deploy-telegram', 'Deploy your first Telegram agent', [
              '-2-daemon',
              '-3-operate',
            ]),
          ],
        },
        {
          type: 'category',
          label: 'Install & providers',
          collapsed: true,
          items: [
            'using/how-to/install-on-windows',
            splitDoc('using/how-to/install-on-windows-wsl2', 'Install Ethos on Windows (WSL2)', [
              '/files-networking-gateway',
            ]),
            'using/how-to/configure-providers',
            splitDoc('using/how-to/use-aws-bedrock', 'Run Ethos on AWS Bedrock', [
              '/iam-and-config',
            ]),
            'using/how-to/configure-local-serving',
            'using/how-to/qualify-a-local-model',
            'using/how-to/use-chatgpt-subscription-via-codex',
          ],
        },
        {
          type: 'category',
          label: 'Deploy & run',
          collapsed: true,
          items: [
            splitDoc('using/how-to/deploy-in-production', 'Deploy Ethos in production', [
              '/pm2-and-operate',
            ]),
            splitDoc('using/how-to/deploy-on-ec2', 'Deploy Ethos on AWS EC2', [
              '/service-and-operate',
            ]),
            splitDoc('using/how-to/run-in-docker', 'Run Ethos in Docker', [
              '/configuration',
              '/healthcheck-run-kubernetes',
            ]),
            splitDoc('using/how-to/run-as-daemon', 'Run Ethos as a daemon', [
              '/launchd',
              '/systemd',
              '/windows-and-pm2',
            ]),
            splitDoc('using/how-to/use-zero-mode', 'Use zero mode', ['/personality-session-model']),
          ],
        },
        {
          type: 'category',
          label: 'Channels & bots',
          collapsed: true,
          items: [
            splitDoc('using/how-to/run-multiple-bots', 'Run multiple bots from one Ethos process', [
              '/isolation-and-start',
            ]),
            'using/how-to/run-channels-over-webhooks',
            'using/how-to/receive-files-via-telegram',
            'using/how-to/receive-files-via-slack',
            'using/how-to/send-cross-channel-messages',
          ],
        },
        {
          type: 'category',
          label: 'Voice & calls',
          collapsed: true,
          items: [
            'using/how-to/local-voice',
            'using/how-to/voice-notes-on-channels',
            splitDoc('using/how-to/run-a-wake-satellite', 'Run a wake satellite', [
              '/edge-stt-and-settings',
              '/microphone-and-playout',
            ]),
            splitDoc('using/how-to/answer-phone-calls', 'Give an agent a phone number', [
              '/run-and-verify',
            ]),
          ],
        },
        {
          type: 'category',
          label: 'Teams & memory',
          collapsed: true,
          items: [
            'using/how-to/run-a-team-with-kanban',
            'using/how-to/work-with-a-team',
            'using/how-to/use-team-memory',
            'using/how-to/group-chat-memory',
            'using/how-to/incognito-sessions',
            'using/how-to/get-to-know-new-users',
            splitDoc('using/how-to/peer-two-ethos-agents', 'Peer two Ethos agents over A2A', [
              '/peer-identities',
              '/send-and-audit',
            ]),
          ],
        },
        {
          type: 'category',
          label: 'Skills & automation',
          collapsed: true,
          items: [
            'using/how-to/use-skills',
            splitDoc('using/how-to/manage-skill-evolution', 'Manage skill evolution', [
              '/reject-rollback-archive',
            ]),
            splitDoc(
              'using/how-to/review-personality-change-requests',
              "Review a personality's change request",
              ['/apply-decline-rollback'],
            ),
            'using/how-to/run-a-birth-ritual',
            splitDoc('using/how-to/schedule-tasks-with-cron', 'Schedule tasks with cron', [
              '/test-and-manage',
              '/job-behavior',
            ]),
            'using/how-to/loop-over-tools-in-code',
            'using/how-to/run-tools-over-ssh',
          ],
        },
        {
          type: 'category',
          label: 'Integrations & MCP',
          collapsed: true,
          items: [
            splitDoc('using/how-to/use-as-mcp-server', 'Use Ethos as an MCP server', [
              '/export-a-personality',
              '/keys-and-http',
              '/dashboard',
            ]),
            splitDoc('using/how-to/set-up-mcp-for-a-personality', 'Set up MCP for a personality', [
              '/web-path',
              '/bearer-token',
            ]),
            'using/how-to/migrate-from-openclaw',
          ],
        },
        {
          type: 'category',
          label: 'Dashboard & files',
          collapsed: true,
          items: [
            splitDoc('using/how-to/use-web-dashboard', 'Use the web dashboard', [
              '/cron-mcp-chat-admin',
            ]),
            'using/how-to/use-admin-panel',
            'using/how-to/retrieve-agent-files',
            'using/how-to/upload-agent-files',
            'using/how-to/interactive-charts-in-chat',
            'using/how-to/use-inline-context-refs',
          ],
        },
        {
          type: 'category',
          label: 'Approvals & identity',
          collapsed: true,
          items: [
            splitDoc(
              'using/how-to/set-up-approval-gates',
              'Set up approval gates for dangerous tool calls',
              ['/approval-surfaces'],
            ),
            splitDoc('using/how-to/use-a-decision-model', 'Use a decision model', [
              '/read-and-ask',
            ]),
            'using/how-to/approve-posts-before-sending',
            'using/how-to/audit-user-identity',
          ],
        },
        {
          type: 'category',
          label: 'Ops & recovery',
          collapsed: true,
          items: [
            splitDoc('using/how-to/back-up-and-restore', 'Back up and restore an Ethos install', [
              '/restore',
            ]),
            'using/how-to/recover-messages-after-a-crash',
            'using/how-to/repair-a-damaged-sessions-database',
            'using/how-to/monitor-with-grafana',
            splitDoc(
              'using/how-to/export-traces-otlp',
              'Export traces to an OpenTelemetry collector',
              ['/backends-privacy-delivery'],
            ),
            'using/how-to/safe-mode',
          ],
        },
        {
          type: 'category',
          label: 'Reference',
          collapsed: true,
          items: [
            splitDoc('using/reference/cli', 'CLI reference', [
              '/setup-and-chat',
              '/gateway-and-serve',
              '/evolve-and-learn',
              '/operations',
              '/diagnostics',
              '/maintenance',
            ]),
            splitDoc('using/reference/config-yaml', 'config.yaml reference', [
              '/provider-and-model',
              '/model-registry',
              '/memory',
              '/telegram-slack-teams',
              '/discord-slack-whatsapp',
              '/bot-settings',
              '/email-and-web',
              '/runtime-and-retention',
              '/operations',
              '/learning',
              '/voice',
              '/voice-telephony',
              '/voice-wake',
              '/background-and-browser',
            ]),
            splitDoc('using/reference/mcp-config', 'MCP config reference', [
              '/auth-and-secrets',
              '/scoping-and-examples',
            ]),
            'using/reference/messaging-json',
            splitDoc('using/reference/personality-yaml', 'Personality config reference', [
              '/identity-and-execution',
              '/tools-and-context',
              '/safety-voice-display',
            ]),
            'using/reference/slash-commands',
          ],
        },
        {
          type: 'category',
          label: 'Explanation',
          collapsed: true,
          items: [
            splitDoc(
              'using/explanation/what-is-a-personality',
              'Why is personality the unit, not a system prompt?',
              ['/isolation-and-switching'],
            ),
            'using/explanation/built-in-personalities',
            splitDoc(
              'using/explanation/what-is-a-skill',
              'Why skills, separate from tools and personalities?',
              ['/evolution-and-gating'],
            ),
            'using/explanation/learning-inbox',
            splitDoc(
              'using/explanation/memory-model',
              'Why MEMORY.md and USER.md, not a vector store?',
              ['/shared-rooms'],
            ),
            'using/explanation/user-profiles',
            'using/explanation/dreaming',
            'using/explanation/sessions-and-history',
            'using/explanation/plugin-commands',
            'using/explanation/wake-privilege',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Building on Ethos',
      collapsible: false,
      className: 'sidebar-group sidebar-group--building',
      items: [
        splitDoc('building/quickstart', 'Quickstart', ['-2-add-a-tool']),
        {
          type: 'category',
          label: 'Tutorials',
          collapsed: true,
          items: [
            splitDoc('building/tutorials/write-your-first-tool', 'Write your first tool', [
              '-2-write-install-wire',
              '-3-try-it-and-test',
              '-4-progress-and-shape',
            ]),
            'building/tutorials/first-custom-tool-with-capabilities',
            splitDoc('building/tutorials/add-an-llm-provider', 'Add an LLM provider', [
              '-2-implement-the-provider',
              '-3-wire-and-run',
              '-4-tests-and-real-providers',
            ]),
            splitDoc('building/tutorials/add-a-channel-adapter', 'Add a channel adapter', [
              '-2-implement-and-wire',
              '-3-config-and-test',
              '-4-sessions-streaming-voice',
            ]),
            'building/tutorials/first-mission-control',
            splitDoc(
              'building/tutorials/build-custom-dashboard',
              'Build a custom ops dashboard with the SDK',
              ['-2-send-and-assemble'],
            ),
            splitDoc('building/tutorials/build-a-plugin-home-panel', 'Build a plugin Home panel', [
              '-2-panel-and-oauth',
              '-3-tool-calls-tokens-chart',
              '-4-build-and-verify',
            ]),
          ],
        },
        {
          type: 'category',
          label: 'How-to',
          collapsed: true,
          items: [
            splitDoc('building/how-to/create-a-plugin', 'Create a plugin', [
              '/activate-and-register',
              '/test-and-install',
              '/local-dev-entry-point',
              '/local-dev-install-and-iterate',
            ]),
            splitDoc('building/how-to/publish-a-plugin', 'Publish a plugin', ['/test-and-publish']),
            'building/how-to/register-plugin-commands',
            'building/how-to/register-plugin-data-source',
            'building/how-to/write-an-llm-provider-plugin',
            splitDoc(
              'building/how-to/write-a-memory-backend-plugin',
              'Write a memory backend plugin',
              ['/register-and-configure'],
            ),
            splitDoc('building/how-to/add-a-memory-provider', 'Add a memory provider', [
              '/implement',
              '/register-and-test',
            ]),
            'building/how-to/add-a-hook',
            'building/how-to/add-a-skill',
            'building/how-to/add-a-filesystem-tool',
            'building/how-to/add-a-network-tool',
            'building/how-to/add-a-stateful-tool',
            'building/how-to/point-sdk-at-ethos',
            splitDoc(
              'building/how-to/openai-server-chat',
              'Serve Ethos as an OpenAI-compatible backend',
              ['/clients-and-routing', '/retries-and-capabilities'],
            ),
            'building/how-to/connect-open-webui',
            'building/how-to/add-a-panel',
            'building/how-to/display-live-tool-events',
            'building/how-to/authenticate-dashboard-users',
            'building/how-to/build-a-python-client',
            'building/how-to/migrate-cookie-to-api-key',
            'building/how-to/deploy-mission-control-remote',
            'building/how-to/consume-attachments-in-a-tool',
            splitDoc('building/how-to/author-a-canvas-template', 'Author a Canvas template', [
              '/limits-and-render',
            ]),
          ],
        },
        {
          type: 'category',
          label: 'Reference',
          collapsed: true,
          items: [
            'building/reference/agent-event',
            splitDoc('building/reference/tool-interface', 'Tool interface reference', [
              '/tool-and-result',
              '/tool-context',
              '/result-reducers',
            ]),
            splitDoc(
              'building/reference/llm-provider-interface',
              'LLM provider interface reference',
              ['/completion-types'],
            ),
            'building/reference/hook-registry',
            'building/reference/tool-registry',
            'building/reference/storage-interface',
            splitDoc('building/reference/plugin-sdk', 'Plugin SDK reference', [
              '/helpers-and-testing',
            ]),
            'building/reference/personality-registry',
            'building/reference/kanban-tools',
            'building/reference/team-tools',
            'building/reference/image-tools',
            splitDoc('building/reference/vision-tools', 'Vision tools reference', [
              '/examples-and-video',
            ]),
            splitDoc('building/reference/browser-tools', 'Browser tools reference', [
              '/profiles-and-login',
            ]),
            'building/reference/messaging-tools',
            splitDoc('building/reference/outbound-policy', 'Outbound policy reference', [
              '/lifecycle',
              '/review-and-delivery',
            ]),
            'building/reference/card-catalog',
            'building/reference/skills-tools',
            splitDoc('building/reference/cron-tools', 'Cron tools reference', ['/examples']),
            'building/reference/watcher-tools',
            'building/reference/sdk-client',
            'building/reference/sdk-event-stream',
            'building/reference/stability-tier-table',
            'building/reference/api-key-scopes',
            'building/reference/service-coupling-audit',
            'building/reference/model-catalog',
          ],
        },
        {
          type: 'category',
          label: 'Explanation',
          collapsed: true,
          items: [
            splitDoc(
              'building/explanation/personality-as-architecture',
              'Why is personality architecture, not a system prompt?',
              ['/filesystem-and-model', '/wiring-and-schema', '/plugins-identity-skills'],
            ),
            'building/explanation/personality-governance',
            'building/explanation/decision-provider-governance',
            'building/explanation/tool-shape',
            'building/explanation/injection-at-construction',
            splitDoc(
              'building/explanation/hook-execution-models',
              'Why are hooks split into three execution models?',
              ['/claiming-model'],
            ),
            'building/explanation/tool-result-budget',
            splitDoc(
              'building/explanation/context-cost-optimization',
              'Why does Ethos cost so much less to run than a naive agent loop?',
              ['/layers-5-to-7'],
            ),
            'building/explanation/audience-boundary',
            splitDoc(
              'building/explanation/teams-and-meshes',
              'When should you use a mesh of agents, not one?',
              ['/code-review-example', '/routing-and-lifecycle'],
            ),
            'building/explanation/why-orpc',
            'building/explanation/personality-from-outside',
            'building/explanation/sdk-memory-model',
            'building/explanation/stability-tiers',
            'building/explanation/transport-seam',
            'building/explanation/why-attachments-are-a-capability',
            'building/explanation/why-voice-replies-redeliver',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Platforms & security',
      collapsible: false,
      className: 'sidebar-group sidebar-group--platform',
      items: [
        {
          type: 'category',
          label: 'Platforms',
          collapsed: true,
          items: [
            'platforms/cli',
            'platforms/desktop',
            splitDoc('platforms/telegram', 'Telegram adapter', ['/routing', '/access']),
            splitDoc('platforms/discord', 'Discord adapter', ['/routing', '/access']),
            splitDoc('platforms/slack', 'Slack adapter', [
              '/unaddressed-messages',
              '/routing-and-access',
            ]),
            'platforms/capability-matrix',
          ],
        },
        {
          type: 'category',
          label: 'Security',
          collapsed: true,
          items: [
            splitDoc('security/overview', 'Security overview', ['/trade-offs']),
            splitDoc('security/security-boundary', 'Security boundary', ['/beyond-the-register']),
            splitDoc('security/white-paper', 'Security white paper', [
              '/request-protection',
              '/defenses-and-responsibilities',
            ]),
            'security/threat-model',
            splitDoc('security/controls', 'Security controls', [
              '/channel',
              '/tools',
              '/filesystem',
              '/network',
              '/injection-watcher-redaction',
              '/install',
              '/audit-and-access',
            ]),
            splitDoc('security/production-hardening-checklist', 'Production hardening checklist', [
              '/secrets-filesystem-network',
              '/channels-injection-observability',
              '/keys-origins-plugins',
            ]),
            splitDoc('security/least-privilege-tokens', 'Least-privilege tokens', [
              '/chat-platforms',
              '/work-tools',
            ]),
            'security/api-mediated-access',
            'security/process-isolation',
            splitDoc('security/security-fixes', 'Security hardening log', [
              '/fixes-1-8',
              '/fixes-9-16',
              '/promptware',
            ]),
            'security/responsible-disclosure',
          ],
        },
        splitDoc('troubleshooting', 'Troubleshooting', [
          '/tools-and-skills',
          '/channels-and-cron',
          '/error-reference',
        ]),
        'changelog',
      ],
    },
  ],
};

export default sidebars;
