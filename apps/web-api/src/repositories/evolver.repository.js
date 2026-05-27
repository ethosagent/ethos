import { join } from 'node:path';
import { DEFAULT_EVOLVE_CONFIG, loadEvolveConfig } from '@ethosagent/skill-evolver';
import { FsStorage } from '@ethosagent/storage-fs';
export class EvolverRepository {
  storage;
  configPath;
  historyPath;
  dataDir;
  constructor(opts) {
    this.storage = opts.storage ?? new FsStorage();
    this.dataDir = opts.dataDir;
    this.configPath = join(opts.dataDir, 'evolve-config.json');
    this.historyPath = join(opts.dataDir, 'evolver-history.jsonl');
  }
  async getConfig() {
    return loadEvolveConfig(this.configPath, this.storage);
  }
  async setConfig(config) {
    await this.storage.mkdir(this.dataDir);
    const merged = {
      rewriteThreshold: clamp(
        config.rewriteThreshold,
        0,
        1,
        DEFAULT_EVOLVE_CONFIG.rewriteThreshold,
      ),
      newSkillPatternThreshold: clamp(
        config.newSkillPatternThreshold,
        0,
        1,
        DEFAULT_EVOLVE_CONFIG.newSkillPatternThreshold,
      ),
      minRunsBeforeEvolve: Math.max(0, Math.floor(config.minRunsBeforeEvolve)),
      minPatternCount: Math.max(0, Math.floor(config.minPatternCount)),
      autoApprove: config.autoApprove ?? false,
    };
    await this.storage.write(this.configPath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  }
  async listHistory(limit) {
    const raw = await this.storage.read(this.historyPath);
    if (!raw) return [];
    const records = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        records.push({
          ranAt: parsed.ranAt,
          evalOutputPath: parsed.evalOutputPath,
          rewritesProposed: parsed.rewritesProposed,
          newSkillsProposed: parsed.newSkillsProposed,
          skipped: parsed.skipped ?? [],
        });
      } catch {
        // Skip malformed lines rather than failing the whole list.
      }
    }
    // Newest first.
    records.sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
    return records.slice(0, limit);
  }
}
function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
