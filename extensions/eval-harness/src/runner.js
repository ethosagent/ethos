import { ATROPOS_SCHEMA_VERSION } from '@ethosagent/batch-runner';
import { FsStorage } from '@ethosagent/storage-fs';
import { containsScorer, exactMatchScorer, llmJudgeScorer, regexScorer } from './scorers';

class Writer {
  path;
  storage;
  chain = Promise.resolve();
  constructor(path, storage) {
    this.path = path;
    this.storage = storage;
  }
  async init(truncate) {
    if (truncate) await this.storage.write(this.path, '');
  }
  append(record) {
    this.chain = this.chain.then(() =>
      this.storage.append(this.path, `${JSON.stringify(record)}\n`),
    );
    return this.chain;
  }
}
class Semaphore {
  count;
  queue = [];
  constructor(count) {
    this.count = count;
  }
  acquire() {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}
export class EvalRunner {
  loop;
  options;
  constructor(loop, options) {
    this.loop = loop;
    this.options = options;
  }
  async run(tasks, expectedMap, onProgress) {
    const storage = this.options.storage ?? new FsStorage();
    const writer = new Writer(this.options.outputPath, storage);
    await writer.init(true);
    const sem = new Semaphore(this.options.concurrency);
    const promises = [];
    let passed = 0;
    let failed = 0;
    let scoreSum = 0;
    for (const task of tasks) {
      const p = (async () => {
        await sem.acquire();
        try {
          const { score } = await this.runTask(task, expectedMap, writer);
          scoreSum += score;
          if (score >= 1) passed++;
          else failed++;
        } finally {
          sem.release();
          onProgress?.(passed + failed, tasks.length);
        }
      })();
      promises.push(p);
    }
    await Promise.allSettled(promises);
    const total = tasks.length;
    return { total, passed, failed, avgScore: total > 0 ? scoreSum / total : 0 };
  }
  resolveScorer(match) {
    const kind = match ?? this.options.defaultScorer;
    switch (kind) {
      case 'exact':
        return exactMatchScorer;
      case 'regex':
        return regexScorer;
      case 'llm': {
        const { llmProvider } = this.options;
        if (!llmProvider) throw new Error('llm scorer requires llmProvider in EvalRunOptions');
        return llmJudgeScorer(llmProvider);
      }
      default:
        return containsScorer;
    }
  }
  async runTask(task, expectedMap, writer) {
    const sessionKey = `eval:${task.id}`;
    await writer.append({
      schema_version: ATROPOS_SCHEMA_VERSION,
      task_id: task.id,
      turn: 0,
      role: 'user',
      content: task.prompt,
      usage: null,
    });
    let text = '';
    let skillFilesUsed = [];
    let usage = null;
    let errorMsg;
    try {
      for await (const event of this.loop.run(task.prompt, {
        sessionKey,
        personalityId: task.personalityId,
      })) {
        switch (event.type) {
          case 'text_delta':
            text += event.text;
            break;
          case 'context_meta':
            if (Array.isArray(event.data.skillFilesUsed)) {
              skillFilesUsed = event.data.skillFilesUsed;
            }
            break;
          case 'usage':
            usage = {
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
              estimated_cost_usd: event.estimatedCostUsd,
            };
            break;
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    const expected = expectedMap.get(task.id);
    let score = 0;
    let scorerName = this.options.defaultScorer;
    if (!errorMsg && expected) {
      scorerName = expected.match ?? this.options.defaultScorer;
      const scorer = this.resolveScorer(expected.match);
      score = await scorer(text, expected);
    }
    await writer.append({
      schema_version: ATROPOS_SCHEMA_VERSION,
      task_id: task.id,
      turn: 0,
      role: 'assistant',
      content: text,
      usage,
      score,
      scorer: scorerName,
      skill_files_used: skillFilesUsed,
      ...(errorMsg ? { error: errorMsg } : {}),
    });
    return { score };
  }
}
export function parseExpectedJsonl(src) {
  const map = new Map();
  const lines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const obj = JSON.parse(line);
    if (typeof obj.id !== 'string' || typeof obj.expected !== 'string') {
      throw new Error(
        `Line ${i + 1}: each expected record must have string fields "id" and "expected"`,
      );
    }
    const match =
      obj.match === 'exact' ||
      obj.match === 'contains' ||
      obj.match === 'regex' ||
      obj.match === 'llm'
        ? obj.match
        : undefined;
    map.set(obj.id, { id: obj.id, expected: obj.expected, match });
  }
  return map;
}
