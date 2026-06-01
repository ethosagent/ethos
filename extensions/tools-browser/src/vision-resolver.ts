// ---------------------------------------------------------------------------
// Vision resolver: a11y-first, falls back to LLM vision
// ---------------------------------------------------------------------------

export interface VisionResolverOptions {
  apiKey?: string;
  provider?: string; // 'anthropic' | 'openai'
  model?: string;
}

export interface ResolveResult {
  strategy: 'a11y' | 'vision' | 'a11y_only' | 'failed';
  x?: number;
  y?: number;
  elementDescription?: string;
}

export interface VisionCoords {
  x: number;
  y: number;
  cost_usd: number;
}

// Score an a11y node name against the description (0–1)
function scoreMatch(nodeName: string, description: string): number {
  const a = nodeName.toLowerCase().trim();
  const b = description.toLowerCase().trim();

  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.8;

  // Jaccard word overlap
  const aWords = new Set(a.split(/\s+/));
  const bWords = new Set(b.split(/\s+/));
  const intersection = [...aWords].filter((w) => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union === 0 ? 0 : intersection / union;
}

// Walk the a11y snapshot text (YAML from Playwright's ariaSnapshot) and find best matching node.
// Returns the matched text node name if score > 0.7, else null.
export function resolveByA11y(snapshotText: string, description: string): string | null {
  let bestScore = 0;
  let bestName: string | null = null;

  for (const line of snapshotText.split('\n')) {
    // Match quoted names in the snapshot, e.g.:
    //   - button "Submit" [ref=@e1]
    //   - @e1 [button] "Submit"
    //   - textbox "Email" [ref=@e2]
    const matches = line.matchAll(/"([^"]+)"/g);
    for (const m of matches) {
      const name = m[1];
      const score = scoreMatch(name, description);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
  }

  return bestScore > 0.7 ? bestName : null;
}

// Call vision model with screenshot + description, return coords + cost or null.
export async function resolveByVision(
  screenshotB64: string,
  description: string,
  context: string | undefined,
  opts: VisionResolverOptions,
): Promise<VisionCoords | null> {
  if (!opts.apiKey) return null;

  const provider = opts.provider ?? 'anthropic';
  const prompt = `Find "${description}"${context ? ` (${context})` : ''}. Reply ONLY with JSON: {"x":123,"y":456}`;

  try {
    if (provider === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: opts.apiKey });
      const response = await client.messages.create({
        model: opts.model ?? 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: screenshotB64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock?.type !== 'text') return null;
      const coords = parseCoords(textBlock.text);
      if (!coords) return null;
      // Haiku pricing: $0.80/1M input, $4.00/1M output
      const cost_usd =
        response.usage.input_tokens * 0.0000008 + response.usage.output_tokens * 0.000004;
      return { ...coords, cost_usd };
    }

    if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: opts.apiKey });
      const response = await client.chat.completions.create({
        model: opts.model ?? 'gpt-4o',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${screenshotB64}` },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });

      const text = response.choices[0]?.message?.content;
      if (!text) return null;
      const coords = parseCoords(text);
      if (!coords) return null;
      // gpt-4o pricing: $2.50/1M input, $10.00/1M output
      const usage = response.usage;
      const cost_usd = usage
        ? (usage.prompt_tokens ?? 0) * 0.0000025 + (usage.completion_tokens ?? 0) * 0.00001
        : 0;
      return { ...coords, cost_usd };
    }
  } catch {
    return null;
  }

  return null;
}

function parseCoords(text: string): { x: number; y: number } | null {
  try {
    // Extract JSON object from the response (might have surrounding text)
    const match = text.match(/\{[^}]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'x' in parsed &&
      'y' in parsed &&
      typeof (parsed as Record<string, unknown>).x === 'number' &&
      typeof (parsed as Record<string, unknown>).y === 'number'
    ) {
      return {
        x: (parsed as { x: number; y: number }).x,
        y: (parsed as { x: number; y: number }).y,
      };
    }
    return null;
  } catch {
    return null;
  }
}
