export const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: "dashboard", end: true },
  { to: "/vendors", label: "Vendors", icon: "hub", end: false },
  { to: "/routing", label: "Routing", icon: "alt_route", end: false },
  { to: "/settings", label: "Settings", icon: "tune", end: false },
] as const;
