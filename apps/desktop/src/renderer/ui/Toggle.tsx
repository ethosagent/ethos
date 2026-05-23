interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 34,
        height: 20,
        borderRadius: 'var(--radius-full)',
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        backgroundColor: checked ? 'var(--success)' : 'var(--bg-overlay)',
        transition: 'background-color var(--motion-fast) var(--ease)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: 'var(--radius-full)',
          backgroundColor: checked ? 'white' : 'var(--text-tertiary)',
          transition:
            'left var(--motion-fast) var(--ease), background-color var(--motion-fast) var(--ease)',
        }}
      />
    </button>
  );
}
