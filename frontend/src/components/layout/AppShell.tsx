import type { PropsWithChildren } from "react";
import { Header } from "./Header";
import { SideNav } from "./SideNav";
import { BottomNav } from "./BottomNav";

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <SideNav />
      <Header />
      <main className="flex flex-col w-full pt-16 sm:pt-20 pb-20 lg:pb-8 lg:pl-[240px] min-h-screen">
        <div className="flex flex-col w-full px-gutter-mobile sm:px-gutter py-space-sm space-y-space-md max-w-[1600px]">
          {children}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
