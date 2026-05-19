import { type NextRequest, NextResponse } from 'next/server';
import { ethos } from '@/lib/ethos';

/**
 * Server-side proxy for chat.send — keeps the API key on the server.
 * The client component calls this route instead of using the SDK directly.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await ethos.rpc.chat.send(body);
  return NextResponse.json(res);
}
