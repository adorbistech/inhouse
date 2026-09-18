import { NavLink } from "react-router-dom";
import { Icon } from "../ui/Icon";
import { NAV_ITEMS } from "./NavLinks";

export function SideNav() {
  return (
    <nav className="hidden lg:flex flex-col fixed top-0 left-0 bottom-0 w-[240px] bg-surface-container-lowest border-r border-outline-variant pt-space-md z-50">
      <div className="px-space-md pb-space-md border-b border-outline-variant mb-space-sm">
        <span className="font-label-md text-label-md text-primary tracking-widest">ADORBIS</span>
        <div className="font-headline-md text-headline-md font-bold text-on-surface uppercase">INHOUSE</div>
      </div>
      <div className="flex flex-col gap-1 px-space-sm">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-space-sm px-space-sm py-space-sm font-label-md text-label-md uppercase transition-colors ${
                isActive
                  ? "bg-surface-container-high text-primary border-l-2 border-primary"
                  : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low border-l-2 border-transparent"
              }`
            }
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
      <div className="mt-auto px-space-md py-space-md font-code-dense text-code-dense text-outline">
        Inhouse Beta · v0.2.0
      </div>
    </nav>
  );
}
