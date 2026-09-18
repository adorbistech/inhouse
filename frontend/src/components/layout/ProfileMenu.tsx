import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-8 h-8 bg-primary flex items-center justify-center shrink-0"
        aria-label="Profile menu"
        aria-expanded={open}
      >
        <Icon name="person" className="text-on-primary" size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-56 bg-surface-container-high border border-outline-variant z-50 shadow-2xl">
          <div className="px-space-sm py-space-sm border-b border-outline-variant">
            <div className="font-body-md text-body-md text-on-surface font-bold truncate">adorbistech</div>
            <div className="font-code-dense text-code-dense text-on-surface-variant truncate">
              adorbistech@gmail.com
            </div>
          </div>
          <button className="w-full text-left px-space-sm py-1.5 text-on-surface hover:bg-primary hover:text-surface font-label-md text-label-md uppercase flex items-center gap-space-xs">
            <Icon name="person" size={14} />
            <span>Account</span>
          </button>
          <button className="w-full text-left px-space-sm py-1.5 text-on-surface hover:bg-primary hover:text-surface font-label-md text-label-md uppercase flex items-center gap-space-xs">
            <Icon name="tune" size={14} />
            <span>Preferences</span>
          </button>
          <div className="h-[1px] bg-surface-container-highest my-1" />
          <button className="w-full text-left px-space-sm py-1.5 text-error hover:bg-error hover:text-on-error font-label-md text-label-md uppercase flex items-center gap-space-xs">
            <Icon name="logout" size={14} />
            <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  );
}
