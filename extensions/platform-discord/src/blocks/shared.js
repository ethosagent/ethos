// Ethos brand color
const BRAND_COLOR = 0x5865f2;
export function embed(opts) {
  return { color: BRAND_COLOR, ...opts };
}
export function field(name, value, inline = false) {
  return { name, value, inline };
}
export function escapeMarkdown(text) {
  return text.replace(/([*_~`|\\])/g, '\\$1');
}
export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
export function button(label, customId, style = 2) {
  return { type: 2, style, label, custom_id: customId };
}
export function actionRow(...buttons) {
  return { type: 1, components: buttons.slice(0, 5) };
}
export function plaintextFromEmbed(emb) {
  const parts = [];
  if (emb.title) parts.push(emb.title);
  if (emb.description) parts.push(emb.description);
  if (emb.fields) {
    for (const f of emb.fields) {
      parts.push(`${f.name}: ${f.value}`);
    }
  }
  return parts.join('\n');
}
