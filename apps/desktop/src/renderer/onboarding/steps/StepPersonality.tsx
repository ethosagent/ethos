import { useEffect, useState } from 'react';
import { PersonalityRow } from '../components/PersonalityRow';

interface Personality {
  id: string;
  name: string;
  description: string;
  accent: string;
  isBuiltin: boolean;
}

interface StepPersonalityProps {
  selectedPersonalityId: string | null;
  onSelectPersonality: (id: string) => void;
}

export function StepPersonality({
  selectedPersonalityId,
  onSelectPersonality,
}: StepPersonalityProps) {
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.ethos.personalities.list().then((list) => {
      setPersonalities(list);
      setLoading(false);
    });
  }, []);

  return (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Choose your agent's style
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 24 }}>
        You can change this or create your own at any time.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders have no stable id
                key={i}
                style={{
                  height: 56,
                  backgroundColor: 'var(--bg-elevated)',
                  borderRadius: 'var(--radius-md)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))
          : personalities.map((p) => (
              <PersonalityRow
                key={p.id}
                name={p.name}
                description={p.description}
                accent={p.accent}
                selected={selectedPersonalityId === p.id}
                onSelect={() => onSelectPersonality(p.id)}
              />
            ))}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
