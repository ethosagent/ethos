'use client';

import { useState } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { SessionList } from '@/components/SessionList';
import { SidePanel } from '@/components/SidePanel';

export default function Home() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activePersonalityId, setActivePersonalityId] = useState<string | null>(null);

  return (
    <div className="grid h-full grid-cols-[250px_1fr_300px]">
      <SessionList activeSessionId={activeSessionId} onSelectSession={setActiveSessionId} />
      <ChatPanel
        sessionId={activeSessionId}
        personalityId={activePersonalityId}
        onSessionCreated={setActiveSessionId}
      />
      <SidePanel personalityId={activePersonalityId} onPersonalityChange={setActivePersonalityId} />
    </div>
  );
}
