import { Icon } from "./Icon";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: string;
  children: React.ReactNode;
}

export function Drawer({ open, onClose, title, subtitle, icon = "hub", children }: DrawerProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-surface-container-lowest/90 backdrop-blur-md overflow-y-auto flex flex-col"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-w-3xl w-full mx-auto my-space-lg bg-surface-container p-space-lg flex flex-col gap-space-lg relative">
        <div className="flex items-start justify-between bg-surface-container-high p-space-md">
          <div>
            <div className="flex items-center gap-space-xs">
              <Icon name={icon} className="text-primary" size={20} />
              <span className="font-headline-lg text-headline-lg font-bold text-on-surface uppercase">{title}</span>
            </div>
            {subtitle && <p className="font-body-md text-body-md text-on-surface-variant mt-1">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 bg-surface-container hover:bg-error hover:text-on-error text-on-surface flex items-center justify-center shrink-0"
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
