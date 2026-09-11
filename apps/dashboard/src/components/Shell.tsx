"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSession, type Capability } from "@/lib/session";
import { useZoneStream } from "@/lib/realtime";
import { Login } from "@/components/Login";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Hidden unless the role has this. Presentation only — the API decides. */
  needs?: Capability;
}

const NAV: NavItem[] = [
  { href: "/", label: "Live", icon: "▦" },
  { href: "/orders", label: "Orders", icon: "☕", needs: "orders:manage" },
  { href: "/sessions", label: "Sessions", icon: "⏱" },
  { href: "/analytics", label: "Revenue", icon: "₹", needs: "analytics" },
  { href: "/shop", label: "Shop", icon: "▤", needs: "products:manage" },
  { href: "/events", label: "Events", icon: "⚑", needs: "events:manage" },
  { href: "/staff", label: "Staff", icon: "☷", needs: "staff:manage" },
  { href: "/audit", label: "Audit", icon: "⎘", needs: "audit:view" },
  { href: "/migration", label: "Import", icon: "⇪", needs: "migration" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { staff, loading, logout, can } = useSession();
  const pathname = usePathname();
  const stream = useZoneStream(staff?.zoneId);

  // Nothing renders as logged-in until the stored token has been checked, so a
  // revoked token never flashes a populated dashboard.
  if (loading) {
    return (
      <div className="login">
        <div className="login__card">
          <div className="login__brand">SEIKA</div>
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ width: "70%" }} />
            <div className="skeleton" style={{ width: "45%" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!staff) return <Login />;

  const visible = NAV.filter((item) => !item.needs || can(item.needs));

  return (
    <div className="shell">
      <nav className="nav" aria-label="Sections">
        {visible.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="nav__item" data-active={active}>
              <span className="nav__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="shell__body">
        <header className="topbar">
          <span className="topbar__brand">SEIKA</span>
          <span className="topbar__zone">{staff.role.replace(/_/g, " ")}</span>
          <div className="topbar__right">
            {/* Whether the live stream is connected is operational information:
                a stale PC map looks identical to a quiet zone. */}
            <span
              className="live"
              data-connected={stream.connected}
              title={stream.connected ? "Receiving live updates" : "Reconnecting"}
            >
              <span className="dot" />
              {stream.connected ? "Live" : "Offline"}
            </span>
            <button className="btn--sm" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
