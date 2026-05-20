export interface SendMessageParams {
  sessionId?: string;
  clientId: string;
  text: string;
  personalityId?: string;
}

export interface SendMessageResult {
  sessionId: string;
}

export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  return res.json() as Promise<SendMessageResult>;
}
