interface TabsProps {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div className={`flex items-center overflow-x-auto bg-surface px-space-sm gap-space-xs pt-space-xs ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`font-label-md text-label-md uppercase px-space-sm py-2 shrink-0 border-b-2 transition-colors ${
              isActive
                ? "bg-surface-container-low text-primary border-primary"
                : "text-on-surface-variant hover:text-on-surface border-transparent"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
