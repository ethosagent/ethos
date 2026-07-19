# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

> All pages adhere to the `/docs` skill at [.agents/skills/docs/SKILL.md](../.agents/skills/docs/SKILL.md) — the canonical docs system. Read it before writing or restructuring any page. It defines the persona shell (Using Ethos / Building on Ethos), the four page kinds (tutorial / how-to / reference / explanation), the front-matter contract, voice rules, anti-patterns, and the page-acceptance checklist.

## Installation

```bash
yarn
```

## Local Development

```bash
yarn start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
yarn build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

The production docs site ([https://ethosagent.ai](https://ethosagent.ai)) is served via Cloudflare Pages. Deploys are triggered automatically by commits landing on `main` — no manual deploy step is needed.

The commands below are the Docusaurus defaults for GitHub Pages hosting and are not used for production.

Using SSH:

```bash
USE_SSH=true yarn deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> yarn deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
