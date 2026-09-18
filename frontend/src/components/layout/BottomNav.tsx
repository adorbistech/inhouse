import { NavLink } from "react-router-dom";
import { Icon } from "../ui/Icon";
import { NAV_ITEMS } from "./NavLinks";

export function BottomNav() {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface-container-lowest border-t border-outline-variant pb-safe">
      <div className="flex items-stretch">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-0.5 py-space-sm font-label-md text-label-md uppercase transition-colors ${
                isActive ? "text-primary bg-surface-container-high" : "text-on-surface-variant"
              }`
            }
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
