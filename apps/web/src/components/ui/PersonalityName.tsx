// A personality's name with its `display.emoji` beside it (plan
// personality-presence-and-initiative §2). The emoji is identity DATA the
// operator chose, rendered as text before the name — it is never a nav icon
// and never replaces the generated mark or the accent (DESIGN.md "Anti-slop
// rules" and the nav-icon rule). Unset renders the bare name, so a personality
// without one looks exactly as it did.

/** `🦉 Owl` for plain-text slots (tooltips); the bare name when unset. */
export function personalityLabel(name: string, emoji: string | undefined): string {
  return emoji ? `${emoji} ${name}` : name;
}

/** The name, preceded by the emoji. The emoji is `aria-hidden`: the name
 *  already says who this is, and a screen reader announcing "owl Owl" adds
 *  nothing. */
export function PersonalityName({ name, emoji }: { name: string; emoji?: string }) {
  if (!emoji) return <>{name}</>;
  return (
    <>
      <span className="personality-emoji" aria-hidden="true">
        {emoji}
      </span>
      {name}
    </>
  );
}
