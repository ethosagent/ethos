import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canInstall, scanSkillMd } from '@ethosagent/safety-scanner';
import { FsStorage } from '@ethosagent/storage-fs';
import matter from 'gray-matter';
import { canParse as canParseAgentSkills, parseAgentSkills } from './dialects/agentskills';
import { canParse as canParseHermes, parseHermes } from './dialects/hermes';
import { canParse as canParseOpenClaw, parseOpenClaw } from './dialects/openclaw';
/**
 * Default skill discovery sources.
 * Only ethos-managed directories are on by default. External tool home-dirs
 * (~/.claude/skills, ~/.openclaw/skills, etc.) are opt-in via extraSources
 * because they can contain hundreds of files not intended for ethos.
 */
function defaultTrustedSources() {
    // ~/.ethos/skills/ is user-managed local content. We treat it as
    // trusted-repo so the user's own skills aren't blocked by yellow findings
    // (legitimate mentions of bash, curl, etc.). Red findings (prompt
    // injection) still block.
    return [{ label: 'ethos', dir: join(homedir(), '.ethos', 'skills') }];
}
function defaultCommunitySources() {
    const home = homedir();
    const cwd = process.cwd();
    return [
        { label: 'claude-code', dir: join(home, '.claude', 'skills') },
        { label: 'claude-code-project', dir: join(cwd, '.claude', 'skills') },
        { label: 'opencode-project', dir: join(cwd, '.opencode', 'skills') },
    ];
}
/** Pre-built source descriptors for external tools — add to extraSources to opt in. */
export function externalSources() {
    const home = homedir();
    return [
        { label: 'claude-code', dir: join(home, '.claude', 'skills') },
        { label: 'openclaw', dir: join(home, '.openclaw', 'skills') },
        { label: 'opencode', dir: join(home, '.config', 'opencode', 'skills') },
        { label: 'hermes', dir: join(home, '.hermes', 'skills') },
    ];
}
/**
 * Scans multiple source directories, parses all skill files using dialect
 * detection, and returns a deduped pool keyed by `qualifiedName`.
 * First source wins on name collisions.
 *
 * Trust tier is set by which option a source arrives through, never by
 * the caller — `extraSources` is always `community`, `trustedFirstParty
 * Sources` is always `trusted-repo`. There is no way for an untrusted
 * caller to claim trust by guessing a privileged label.
 */
export class UniversalScanner {
    sources;
    storage;
    cache = new Map();
    onSkip;
    constructor(opts = {}) {
        this.storage = opts.storage ?? new FsStorage();
        const trustedDefaults = opts.sources ? [] : defaultTrustedSources();
        const communityDefaults = opts.sources ?? defaultCommunitySources();
        this.sources = [
            ...trustedDefaults.map((s) => withTier(s, 'trusted-repo')),
            ...(opts.trustedFirstPartySources ?? []).map((s) => withTier(s, 'trusted-repo')),
            ...communityDefaults.map((s) => withTier(s, 'community')),
            ...(opts.extraSources ?? []).map((s) => withTier(s, 'community')),
        ];
        this.onSkip = opts.onSkip;
    }
    /**
     * Returns the global skill pool as a map of qualifiedName → Skill.
     * Logs a one-line boot summary to stdout.
     */
    async scan() {
        const pool = new Map();
        for (const source of this.sources) {
            const files = await this.discoverFiles(source.dir);
            for (const filePath of files) {
                const skill = await this.loadSkill(filePath, source);
                if (!skill)
                    continue;
                // First source wins on name collision
                if (!pool.has(skill.qualifiedName)) {
                    pool.set(skill.qualifiedName, skill);
                }
            }
        }
        return pool;
    }
    /**
     * Add extra community-tier sources after construction. Called by wiring
     * after plugin loading to inject plugin-declared skill directories into
     * the live scanner without rebuilding it.
     */
    addExtraSources(sources) {
        for (const s of sources) {
            this.sources.push(withTier(s, 'community'));
        }
    }
    async discoverFiles(dir) {
        let entries;
        try {
            entries = await this.storage.listEntries(dir);
        }
        catch (err) {
            const code = err.code ?? 'unknown';
            this.onSkip?.(dir, `skill source not readable (${code}) — skipped`);
            return [];
        }
        if (entries.length === 0)
            return [];
        const found = [];
        for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name === 'pending')
                continue;
            if (entry.isDir) {
                const subPath = join(dir, entry.name);
                const skillMd = join(subPath, 'SKILL.md');
                if ((await this.storage.mtime(skillMd)) !== null) {
                    found.push(skillMd);
                    continue;
                }
                // Scoped: <dir>/<scope>/<slug>/SKILL.md
                let inner;
                try {
                    inner = await this.storage.listEntries(subPath);
                }
                catch (err) {
                    const code = err.code ?? 'unknown';
                    this.onSkip?.(subPath, `skill source not readable (${code}) — skipped`);
                    continue;
                }
                for (const child of [...inner].sort((a, b) => a.name.localeCompare(b.name))) {
                    if (!child.isDir)
                        continue;
                    const nested = join(subPath, child.name, 'SKILL.md');
                    if ((await this.storage.mtime(nested)) !== null)
                        found.push(nested);
                }
            }
            else if (entry.name.endsWith('.md')) {
                found.push(join(dir, entry.name));
            }
        }
        return found;
    }
    skillNameFor(filePath, sourceDir) {
        const b = basename(filePath);
        if (b !== 'SKILL.md')
            return b.replace(/\.md$/, '');
        const parentDir = dirname(filePath);
        const grandparent = dirname(parentDir);
        if (grandparent === sourceDir)
            return basename(parentDir);
        return `${basename(grandparent)}/${basename(parentDir)}`;
    }
    async loadSkill(filePath, source) {
        const mtimeMs = await this.storage.mtime(filePath);
        if (mtimeMs === null)
            return null;
        const cached = this.cache.get(filePath);
        if (cached && cached.mtime === mtimeMs)
            return cached.skill;
        const raw = await this.storage.read(filePath);
        if (!raw)
            return null;
        const name = this.skillNameFor(filePath, source.dir);
        const qualifiedName = `${source.label}/${name}`;
        const skill = this.parseWithDialect(raw, filePath, source.label, name, qualifiedName, mtimeMs);
        // Trust tier is fixed by which option the source arrived through —
        // `extraSources` always lands on `community`, `trustedFirstParty
        // Sources` on `trusted-repo`. Callers cannot self-escalate.
        const scanResult = scanSkillMd(raw, filePath);
        const decision = canInstall(scanResult, source.trustTier);
        if (!decision.allowed) {
            this.onSkip?.(qualifiedName, `safety scan: ${decision.blockedBy}`);
            return null;
        }
        this.cache.set(filePath, { mtime: mtimeMs, skill });
        return skill;
    }
    parseWithDialect(raw, filePath, source, name, qualifiedName, mtimeMs) {
        const { data } = matter(raw);
        const fm = data;
        let partial = null;
        if (canParseOpenClaw(fm)) {
            partial = parseOpenClaw(raw, filePath, source, name, mtimeMs);
        }
        else if (canParseAgentSkills(fm)) {
            partial = parseAgentSkills(raw, filePath, source, name, mtimeMs);
        }
        else if (canParseHermes(fm)) {
            partial = parseHermes(raw, filePath, source, name, mtimeMs);
        }
        if (partial)
            return { ...partial, qualifiedName };
        // Legacy: plain markdown with no recognized frontmatter
        const { content } = matter(raw);
        return {
            qualifiedName,
            name,
            source,
            filePath,
            body: content.trim() || raw,
            rawFrontmatter: fm,
            dialect: 'legacy',
            mtimeMs,
        };
    }
}
function withTier(source, trustTier) {
    return { ...source, trustTier };
}
