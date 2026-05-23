import { useCallback, useEffect, useRef, useState } from 'react';

interface QuickChatEthosApi {
  platform: string;
  chat: {
    send(message: string): Promise<unknown>;
    onStream(cb: (chunk: string) => void): () => void;
    onDone(cb: (fullText: string) => void): () => void;
  };
  quickChat: {
    close(): void;
    openInMain(): void;
  };
}

const ethos = (window as unknown as { ethos: QuickChatEthosApi }).ethos;

export function QuickChatComposer() {
  const [input, setInput] = useState('');
  const [response, setResponse] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const unsubStream = ethos.chat.onStream((chunk) => {
      setResponse((prev) => prev + chunk);
    });

    const unsubDone = ethos.chat.onDone((fullText) => {
      setResponse(fullText);
      setIsStreaming(false);
    });

    return () => {
      unsubStream();
      unsubDone();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on response change
  useEffect(() => {
    const el = responseRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [response]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ethos.quickChat.close();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = input.trim();
        if (!text || isStreaming) return;

        setInput('');
        setResponse('');
        setIsStreaming(true);
        ethos.chat.send(text);
      }
    },
    [input, isStreaming],
  );

  return (
    <>
      <textarea
        className="quick-chat-textarea"
        placeholder="Ask Ethos anything..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        ref={textareaRef}
      />
      {(response || isStreaming) && (
        <div className="quick-chat-response" ref={responseRef}>
          {response}
        </div>
      )}
      <div className="quick-chat-footer">
        <button
          type="button"
          className="quick-chat-open-link"
          onClick={() => ethos.quickChat.openInMain()}
        >
          Open in Ethos
        </button>
      </div>
    </>
  );
}
