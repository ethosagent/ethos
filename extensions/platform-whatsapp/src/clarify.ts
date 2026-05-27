export interface ClarifyOption {
  label: string;
  value: string;
}

export function buildClarifyMessage(
  question: string,
  options: ClarifyOption[],
):
  | { text: string }
  | { buttonMessage: unknown }
  | { listMessage: unknown } {
  if (options.length === 0) {
    return { text: question };
  }

  if (options.length <= 3) {
    return {
      buttonMessage: {
        contentText: question,
        buttons: options.map((opt, i) => ({
          buttonId: `clarify_${i}`,
          buttonText: { displayText: opt.label },
          type: 1,
        })),
        headerType: 1,
      },
    };
  }

  return {
    listMessage: {
      title: 'Choose an option',
      description: question,
      buttonText: 'Options',
      sections: [
        {
          title: 'Options',
          rows: options.map((opt, i) => ({
            rowId: `clarify_${i}`,
            title: opt.label,
            description: opt.value,
          })),
        },
      ],
    },
  };
}

export function buildNumberedFallback(
  question: string,
  options: ClarifyOption[],
): string {
  const lines = [question, ''];
  options.forEach((opt, i) => {
    lines.push(`${i + 1}. ${opt.label}`);
  });
  lines.push('', 'Reply with the number of your choice.');
  return lines.join('\n');
}
