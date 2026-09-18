interface StatCardProps {
  label: string;
  value: string;
  sublabel?: string;
  accent?: "primary" | "secondary" | "tertiary" | "error";
  trailing?: React.ReactNode;
  valueTone?: string;
}

const ACCENT_BAR: Record<NonNullable<StatCardProps["accent"]>, string> = {
  primary: "bg-primary",
  secondary: "bg-secondary",
  tertiary: "bg-tertiary",
  error: "bg-error",
};

export function StatCard({ label, value, sublabel, accent = "primary", trailing, valueTone }: StatCardProps) {
  return (
    <div className="bg-surface-container-low p-space-sm flex flex-col justify-between relative overflow-hidden">
      <div className={`w-full h-1 ${ACCENT_BAR[accent]} absolute top-0 left-0`} />
      <div className="flex justify-between items-start">
        <span className="font-label-md text-label-md text-on-surface-variant uppercase">{label}</span>
        {trailing}
      </div>
      <div className="mt-space-xs">
        <span className={`font-headline-lg text-headline-lg font-bold ${valueTone ?? "text-on-surface"}`}>
          {value}
        </span>
      </div>
      {sublabel && (
        <div className="font-code-dense text-code-dense text-outline mt-0.5 truncate">{sublabel}</div>
      )}
    </div>
  );
}
