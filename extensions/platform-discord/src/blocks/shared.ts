export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordButton {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

// Ethos brand color
const BRAND_COLOR = 0x5865f2;

export function embed(opts: Partial<DiscordEmbed> & { description: string }): DiscordEmbed {
  return { color: BRAND_COLOR, ...opts };
}

export function field(
  name: string,
  value: string,
  inline = false,
): { name: string; value: string; inline: boolean } {
  return { name, value, inline };
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([*_~`|\\])/g, '\\$1');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function button(label: string, customId: string, style: 1 | 2 | 3 | 4 = 2): DiscordButton {
  return { type: 2, style, label, custom_id: customId };
}

export function actionRow(...buttons: DiscordButton[]): DiscordActionRow {
  return { type: 1, components: buttons.slice(0, 5) };
}

export function plaintextFromEmbed(emb: DiscordEmbed): string {
  const parts: string[] = [];
  if (emb.title) parts.push(emb.title);
  if (emb.description) parts.push(emb.description);
  if (emb.fields) {
    for (const f of emb.fields) {
      parts.push(`${f.name}: ${f.value}`);
    }
  }
  return parts.join('\n');
}
