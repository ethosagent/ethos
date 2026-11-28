import { join } from 'node:path';
import {
  buildWeeklyDigest,
  isoWeekLabel,
  type WorldChangesSource,
  waitingSkillNamesByPersonality,
} from '@ethosagent/digest';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import type { LearningLogEntry, Storage } from '@ethosagent/types';
import type { DigestLatest } from '@ethosagent/web-contracts';

// Digest service — the most recent weekly governed-learning digest written to
// `<dataDir>/digests/<ISO-week>.md`. `latest()` is the read-only view;
// `generate()` runs the same pure generator the CLI / weekly cron drives
// (minus email + console) and writes the file for the current ISO week.

export interface DigestServiceOptions {
  storage: Storage;
  dataDir: string;
  /** Shared with the loop so generation sees the same hot-reloaded set the
   *  rest of the web-api works against. */
  personalities: FilePersonalityRegistry;
  /**
   * The learning inbox's waiting skill candidates (`LearningService.pendingSkills`),
   * which the digest counts. Absent (tests) → no candidates.
   */
  learning?: {
    pendingSkills(): Promise<ReadonlyArray<{ personalityId: string; destination: string }>>;
  };
  /** The optional "World changes" section's source; absent when `world.enabled` is off. */
  worldChanges?: WorldChangesSource;
  /** Reports a failing world source; the digest is written without the section. */
  onError?: (err: unknown) => void;
}

export class DigestService {
  constructor(private readonly opts: DigestServiceOptions) {}

  /**
   * Return the most recent digest, or null when none exist. The digest
   * filenames are ISO `YYYY-Www`, which sorts lexicographically by recency —
   * so the greatest `*.md` filename is the newest week.
   */
  async latest(): Promise<DigestLatest | null> {
    const { storage, dataDir } = this.opts;
    const dir = join(dataDir, 'digests');
    const entries = await storage.list(dir);
    const files = entries.filter((name) => name.endsWith('.md'));
    if (files.length === 0) return null;
    files.sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    const path = join(dir, newest);
    const markdown = await storage.read(path);
    if (markdown === null) return null;
    const mtime = await storage.mtime(path);
    return {
      label: newest.slice(0, -3),
      markdown,
      generatedAt: new Date(mtime ?? 0).toISOString(),
    };
  }

  /**
   * Build the digest for the current ISO week across every user (non-builtin)
   * personality and write it to `<dataDir>/digests/<ISO-week>.md`, overwriting
   * the same week's file (idempotent per week). Returns the written digest, or
   * null when there are no user personalities to report on. This is the web
   * equivalent of `ethos digest run` minus the email + console surface.
   */
  async generate(): Promise<DigestLatest | null> {
    const { storage, dataDir, personalities } = this.opts;

    const targets = personalities
      .describeAll()
      .filter((d) => !d.builtin)
      .map((d) => d.config);
    if (targets.length === 0) return null;

    const learningLogByPersonality: Record<string, LearningLogEntry[]> = {};
    for (const cfg of targets) {
      try {
        const soul = await personalities.readLivingSoul(cfg.id);
        learningLogByPersonality[cfg.id] = soul.learningLog;
      } catch {
        learningLogByPersonality[cfg.id] = [];
      }
    }

    const waiting = (await this.opts.learning?.pendingSkills()) ?? [];

    const now = new Date();
    const markdown = await buildWeeklyDigest({
      personalities: targets,
      storage,
      dataDir,
      now,
      learningLogByPersonality,
      pendingSkillCandidatesByPersonality: waitingSkillNamesByPersonality(waiting),
      // The web digest is read by the owner in the dashboard, never delivered to a room, so
      // owner_only worlds are included (digest world-section.test.ts pins the filter).
      deliveryAudience: 'private',
      ...(this.opts.worldChanges ? { worldChanges: this.opts.worldChanges } : {}),
      ...(this.opts.onError ? { onError: this.opts.onError } : {}),
    });

    const label = isoWeekLabel(now);
    const digestDir = join(dataDir, 'digests');
    await storage.mkdir(digestDir);
    await storage.writeAtomic(join(digestDir, `${label}.md`), markdown);

    return { label, markdown, generatedAt: new Date().toISOString() };
  }
}
