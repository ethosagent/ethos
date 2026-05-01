export interface McpPrompt {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export const PROMPTS: McpPrompt[] = [
  {
    name: 'code_review',
    description: 'Structured code review using the researcher and reviewer personalities',
    arguments: [{ name: 'code', description: 'The code to review', required: true }],
  },
  {
    name: 'research_topic',
    description: 'Deep research with citations using the researcher personality',
    arguments: [
      { name: 'topic', description: 'The topic or question to research', required: true },
    ],
  },
  {
    name: 'reflect_on_decision',
    description: 'Structured reflection and coaching using the coach personality',
    arguments: [
      { name: 'decision', description: 'The decision or situation to reflect on', required: true },
    ],
  },
  {
    name: 'debug_failure',
    description: 'Evidence-first failure investigation using the engineer personality',
    arguments: [
      {
        name: 'failure',
        description: 'Description of the failure or error to investigate',
        required: true,
      },
    ],
  },
];

const PROMPT_TEMPLATES: Record<string, (args: Record<string, string>) => string> = {
  code_review: ({ code }) =>
    `Review the following code. Provide structured feedback covering: correctness, security, performance, readability, and maintainability. Be specific and cite line numbers where relevant.\n\n\`\`\`\n${code}\n\`\`\``,

  research_topic: ({ topic }) =>
    `Research the following topic thoroughly. Require citations for factual claims. Structure your response with: summary, key findings, evidence, limitations, and further reading.\n\nTopic: ${topic}`,

  reflect_on_decision: ({ decision }) =>
    `Help me reflect on this decision or situation using a structured coaching approach. Cover: what happened, what I was thinking/feeling, what went well, what I would do differently, and what I will do next time.\n\nSituation: ${decision}`,

  debug_failure: ({ failure }) =>
    `Investigate this failure using an evidence-first approach. Start with observable facts, then hypotheses, then tests to confirm/reject each. Do not guess without evidence.\n\nFailure: ${failure}`,
};

export function getPromptMessages(
  name: string,
  args: Record<string, string>,
): Array<{ role: 'user'; content: { type: 'text'; text: string } }> {
  const template = PROMPT_TEMPLATES[name];
  if (!template) throw new Error(`Unknown prompt: ${name}`);
  return [{ role: 'user', content: { type: 'text', text: template(args) } }];
}
