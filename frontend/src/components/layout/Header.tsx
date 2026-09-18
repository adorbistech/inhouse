import { useLocation } from "react-router-dom";
import { Icon } from "../ui/Icon";
import { ProfileMenu } from "./ProfileMenu";
import { NAV_ITEMS } from "./NavLinks";

export function Header() {
  const location = useLocation();
  const active = NAV_ITEMS.find((item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
  );

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface/95 backdrop-blur-xl border-b border-outline-variant">
      <div className="h-16 sm:h-20 px-gutter-mobile sm:px-gutter flex items-center justify-between lg:pl-[252px]">
        <div className="flex flex-col justify-center min-w-0 pr-space-sm">
          <div className="flex items-center gap-space-xs flex-wrap">
            <span className="font-label-md text-label-md text-primary tracking-widest">ADORBIS</span>
            <span className="font-headline-md text-headline-md tracking-tight font-bold text-on-surface uppercase">
              INHOUSE
            </span>
            <div className="flex items-center gap-space-xs pl-space-xs">
              <span className="bg-surface-container-high text-primary px-space-xs py-0 font-code-dense text-code-dense uppercase tracking-wider">
                BETA
              </span>
              <span className="hidden sm:inline-block bg-surface-container-low text-on-surface-variant px-space-xs font-code-dense text-code-dense uppercase">
                Env: INHOUSE
              </span>
            </div>
          </div>
          <div className="flex items-center gap-space-sm mt-0.5">
            <span className="font-code-dense text-code-dense text-on-surface-variant truncate hidden xs:inline">
              AI Developer Infrastructure
            </span>
            <span className="text-outline-variant font-code-dense text-code-dense hidden sm:inline">•</span>
            <span className="font-label-md text-label-md text-primary uppercase truncate">
              {active?.label ?? ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-space-xs shrink-0">
          <div className="hidden xs:flex items-center gap-1.5 px-space-xs py-1 bg-surface-container-low">
            <span className="w-2 h-2 bg-tertiary" />
            <span className="font-code-dense text-code-dense text-tertiary uppercase">Healthy</span>
          </div>
          <button
            className="w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors"
            aria-label="Notifications"
          >
            <Icon name="notifications" size={20} />
          </button>
          <ProfileMenu />
        </div>
      </div>
    </header>
  );
}
