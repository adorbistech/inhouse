interface PanelProps {
  children: React.ReactNode;
  className?: string;
}

export function Panel({ children, className = "" }: PanelProps) {
  return <div className={`bg-surface-container-low ${className}`}>{children}</div>;
}

interface PanelHeaderProps {
  title: string;
  eyebrow?: string;
  right?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ title, eyebrow, right, className = "" }: PanelHeaderProps) {
  return (
    <div
      className={`bg-surface-container-high px-space-md py-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs ${className}`}
    >
      <div className="flex items-center gap-space-sm min-w-0">
        {eyebrow && (
          <span className="font-label-md text-label-md text-primary uppercase shrink-0">{eyebrow}</span>
        )}
        <span className="font-headline-md text-headline-md text-on-surface font-bold truncate">{title}</span>
      </div>
      {right && <div className="flex items-center gap-space-xs shrink-0">{right}</div>}
    </div>
  );
}
