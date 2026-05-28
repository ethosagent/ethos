import { embed, escapeMarkdown, field, truncate } from './shared';
export function personalityEmbed(input) {
    const fields = [
        field('Name', escapeMarkdown(input.name), true),
        field('Description', truncate(escapeMarkdown(input.description), 1024)),
    ];
    if (input.model) {
        fields.push(field('Model', escapeMarkdown(input.model), true));
    }
    if (input.toolset && input.toolset.length > 0) {
        fields.push(field('Toolset', truncate(input.toolset.map((t) => `\`${escapeMarkdown(t)}\``).join(', '), 1024)));
    }
    return embed({ title: 'Personality', description: '', fields });
}
