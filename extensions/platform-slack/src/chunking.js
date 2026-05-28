// Newline-preferring text chunker plus an edit-append-delete reflow helper.
// Lifted unchanged from the pre-refactor `index.ts` so existing tests keep
// asserting against the same exported symbols.
export function chunkText(text, maxLength = 3000) {
    if (text.length <= maxLength)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        const newline = remaining.lastIndexOf('\n', maxLength);
        const cutAt = newline > maxLength * 0.6 ? newline + 1 : maxLength;
        chunks.push(remaining.slice(0, cutAt));
        remaining = remaining.slice(cutAt);
    }
    return chunks;
}
/**
 * Re-flow `newChunks` over `existingIds`. Edits the first N chunks in place,
 * appends extras, and deletes trailing existing chunks no longer needed.
 * Delete failures are swallowed (best-effort).
 */
export async function reflowChunks(newChunks, existingIds, ops) {
    const updated = [];
    for (let i = 0; i < newChunks.length; i++) {
        if (i < existingIds.length) {
            updated.push(await ops.edit(existingIds[i], newChunks[i]));
        }
        else {
            updated.push(await ops.append(newChunks[i]));
        }
    }
    for (let i = newChunks.length; i < existingIds.length; i++) {
        try {
            await ops.deleteId(existingIds[i]);
        }
        catch {
            // best-effort delete
        }
    }
    return updated;
}
