import type { NextRequest } from 'next/server';

/**
 * Server-side SSE proxy — forwards the EventStream connection to the Ethos
 * server with the API key attached server-side. The client connects to this
 * route without credentials; this route connects upstream with the real key.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return new Response('Missing sessionId', { status: 400 });
  }

  const baseUrl = process.env.ETHOS_BASE_URL ?? 'http://localhost:3000';
  const apiKey = process.env.ETHOS_API_KEY ?? '';

  const upstream = await fetch(`${baseUrl}/api/events?sessionId=${sessionId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream SSE connection failed', { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
