import type { HealthState } from "../../types/domain";

const STATE_STYLES: Record<HealthState, { dot: string; text: string; label: string }> = {
  healthy: { dot: "bg-tertiary", text: "text-tertiary", label: "Healthy" },
  degraded: { dot: "bg-secondary", text: "text-secondary", label: "Degraded" },
  disabled: { dot: "bg-outline", text: "text-outline", label: "Disabled" },
  unreachable: { dot: "bg-error", text: "text-error", label: "Unreachable" },
};

interface StatusPillProps {
  state: HealthState;
  detail?: string;
  className?: string;
}

export function StatusPill({ state, detail, className = "" }: StatusPillProps) {
  const s = STATE_STYLES[state];
  return (
    <div className={`flex items-center gap-1 bg-surface-container-high px-space-xs py-1 ${className}`}>
      <span className={`w-1.5 h-1.5 ${s.dot}`} />
      <span className={`font-code-dense text-code-dense uppercase ${s.text}`}>
        {detail ?? s.label}
      </span>
    </div>
  );
}
