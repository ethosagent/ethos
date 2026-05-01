import { Box, Text } from 'ink';

interface PersonalityMarkProps {
  personality: string;
  accentColor: string;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function PersonalityMark({ personality, accentColor }: PersonalityMarkProps) {
  const hash = fnv1a32(personality);
  const chars = ['░', '▒', '▓', '█'];
  const rows: Array<{ id: string; line: string }> = [];

  for (let y = 0; y < 4; y++) {
    let row = '';
    for (let x = 0; x < 2; x++) {
      const bitIndex = y * 2 + x;
      const on = ((hash >> bitIndex) & 1) === 1;
      const shadeIndex = (hash >> (16 + bitIndex * 2)) & 0x3;
      const glyph = on ? (chars[shadeIndex] ?? '▓') : ' ';
      row += glyph;
    }
    const line = `${row}${row.split('').reverse().join('')}`;
    rows.push({ id: `${personality}-${y}`, line });
  }

  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Text key={row.id} color={accentColor}>
          {row.line}
        </Text>
      ))}
    </Box>
  );
}
