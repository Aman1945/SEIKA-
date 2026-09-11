"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePlayer } from "@/lib/session";
import { Login } from "@/components/Login";

const TABS = [
  { href: "/", label: "Passport", icon: "◈" },
  { href: "/play", label: "Play", icon: "▶" },
  { href: "/wallet", label: "Wallet", icon: "₹" },
  { href: "/shop", label: "Shop", icon: "☕" },
  { href: "/ranks", label: "Ranks", icon: "♛" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { passport, loading } = usePlayer();
  const pathname = usePathname();

  if (loading) {
    return (
      <div className="app">
        <div className="page">
          <div className="skeleton" style={{ height: 150, borderRadius: 14 }} />
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      </div>
    );
  }

  if (!passport) return <Login />;

  return (
    <div className="app">
      <div className="page">{children}</div>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} className="tab" data-active={active}>
              <span className="tab__icon" aria-hidden="true">
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
