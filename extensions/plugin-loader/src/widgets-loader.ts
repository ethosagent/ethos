import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WidgetTemplate } from '@ethosagent/types';

/**
 * Load widget templates from a plugin's `widgets.yaml` file.
 * Returns `[]` on any error (missing file, parse error).
 */
export function loadWidgetTemplates(pluginDir: string, pluginId: string): WidgetTemplate[] {
  const filePath = join(pluginDir, 'widgets.yaml');
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  try {
    return parseWidgetsYaml(raw, pluginId);
  } catch {
    return [];
  }
}

/** Simple line-based YAML list parser for widget templates. */
function parseWidgetsYaml(raw: string, pluginId: string): WidgetTemplate[] {
  const templates: WidgetTemplate[] = [];
  let current: Record<string, string> | null = null;

  for (const line of raw.split('\n')) {
    // Strip comments
    const commentIdx = line.indexOf('#');
    const cleaned = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

    // Skip blank lines
    if (cleaned.trim() === '') continue;

    // New list item: `- key: value`
    const listMatch = cleaned.match(/^- (\w+):\s*(.*)/);
    if (listMatch) {
      if (current) {
        const t = mapToTemplate(current, pluginId);
        if (t) templates.push(t);
      }
      current = {};
      const key = listMatch[1] ?? '';
      const val = stripQuotes((listMatch[2] ?? '').trim());
      if (key) current[key] = val;
      continue;
    }

    // Continuation line: `  key: value`
    const contMatch = cleaned.match(/^\s+(\w+):\s*(.*)/);
    if (contMatch && current) {
      const key = contMatch[1] ?? '';
      const val = stripQuotes((contMatch[2] ?? '').trim());
      if (key) current[key] = val;
    }
  }

  // Flush last item
  if (current) {
    const t = mapToTemplate(current, pluginId);
    if (t) templates.push(t);
  }

  return templates;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const VALID_QUERY_TYPES = new Set(['sql', 'prompt']);
const VALID_OUTPUT_TYPES = new Set(['table', 'html', 'image', 'text']);

function mapToTemplate(obj: Record<string, string>, pluginId: string): WidgetTemplate | null {
  const id = obj.id;
  const title = obj.title;
  const queryType = obj.queryType;
  if (!id || !title || !queryType || !VALID_QUERY_TYPES.has(queryType)) return null;

  const template: WidgetTemplate = {
    id,
    pluginId,
    title,
    queryType: queryType as 'sql' | 'prompt',
  };

  if (obj.description) template.description = obj.description;
  if (obj.dataSource) template.dataSource = obj.dataSource;
  if (obj.sql) template.sql = obj.sql;
  if (obj.prompt) template.prompt = obj.prompt;
  if (obj.outputType && VALID_OUTPUT_TYPES.has(obj.outputType)) {
    template.outputType = obj.outputType as 'table' | 'html' | 'image' | 'text';
  }
  if (obj.defaultCron) template.defaultCron = obj.defaultCron;

  return template;
}
