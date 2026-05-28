// FW-14 — readline autocomplete support for the slash command registry.
// Disabled automatically when process.stdin.isTTY is false (pipe mode).
/** Maximum dropdown rows to display at once. */
const MAX_ROWS = 8;
/**
 * Render a filtered dropdown for the given prefix (without the leading '/').
 * Returns an empty string when there are no matches or when the input
 * does not start with '/'.
 */
export function renderDropdown(matches, columns) {
    if (matches.length === 0)
        return '';
    const rows = matches.slice(0, MAX_ROWS);
    const lines = [];
    for (const cmd of rows) {
        const label = cmd.prefix ? `${cmd.prefix} ${cmd.name}` : `/${cmd.name}`;
        const desc = cmd.description;
        const line = `  ${label.padEnd(28)}${desc}`;
        lines.push(line.slice(0, columns - 1));
    }
    const hint = '↑↓ select · Tab accept · Esc dismiss';
    lines.push(`  \x1b[2m${hint}\x1b[0m`);
    return lines.join('\n');
}
/**
 * Build a readline-compatible completer function backed by the given registry.
 * Returns null when stdin is not a TTY (pipe mode — no completion, no dropdown).
 */
export function makeCompleter(registry) {
    if (!process.stdin.isTTY)
        return null;
    return (line) => {
        if (!line.startsWith('/'))
            return [[], line];
        const prefix = line.slice(1);
        const matches = registry.filter(prefix);
        const completions = matches.map((cmd) => {
            return cmd.prefix ? `/${cmd.prefix.replace(/[[\]]/g, '')} ${cmd.name}` : `/${cmd.name}`;
        });
        return [completions, line];
    };
}
