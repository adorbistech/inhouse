interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-space-xs"
      aria-pressed={checked}
    >
      <span className="flex font-code-dense text-code-dense uppercase">
        <span
          className={`px-space-xs py-1 border border-outline-variant ${
            !checked ? "bg-surface-container-highest text-on-surface" : "text-on-surface-variant"
          }`}
        >
          Off
        </span>
        <span
          className={`px-space-xs py-1 border border-l-0 border-outline-variant ${
            checked ? "bg-primary text-on-primary" : "text-on-surface-variant"
          }`}
        >
          On
        </span>
      </span>
      {label && <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">{label}</span>}
    </button>
  );
}
