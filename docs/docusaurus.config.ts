import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

const config: Config = {
  title: 'Ethos',
  tagline: 'TypeScript agent framework where personality is architecture.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://ethosagent.ai',
  baseUrl: '/',

  organizationName: 'ethosagent',
  projectName: 'ethos',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/MiteshSharma/ethos/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/ethos-og-card.png',
    metadata: [
      {
        name: 'keywords',
        content: 'ai agent, typescript, framework, personality, llm, claude, openai',
      },
      {
        name: 'description',
        content:
          'Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically.',
      },
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'ethos',
      logo: {
        alt: 'Ethos',
        src: 'img/favicon.svg',
      },
      items: [
        {
          to: '/docs',
          label: 'Docs',
          position: 'left',
        },
        {
          to: '/docs/using/quickstart',
          label: 'Use',
          position: 'left',
        },
        {
          to: '/docs/building/quickstart',
          label: 'Build',
          position: 'left',
        },
        {
          href: 'https://github.com/MiteshSharma/ethos',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Use Ethos', to: '/docs/using/quickstart' },
            { label: 'Build on Ethos', to: '/docs/building/quickstart' },
            { label: 'CLI reference', to: '/docs/using/reference/cli' },
            { label: 'Glossary', to: '/docs/getting-started/glossary' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub', href: 'https://github.com/MiteshSharma/ethos' },
            { label: 'Issues', href: 'https://github.com/MiteshSharma/ethos/issues' },
            { label: 'Releases', href: 'https://github.com/MiteshSharma/ethos/releases' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Ethos · MIT License`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
