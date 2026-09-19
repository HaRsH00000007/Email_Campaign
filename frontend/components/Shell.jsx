"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api, getToken, clearToken } from "@/lib/api";
import { useMediaQuery, useTheme } from "@/lib/hooks";
import { IconButton, Skeleton } from "@/components/ui";
import {
  LogOut,
  Megaphone,
  Menu,
  Moon,
  PanelLeft,
  Send,
  Sun,
  Users,
  Inbox,
  X,
} from "@/components/icons";

const NAV = [
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/leads", label: "Lead lists", icon: Users },
  { href: "/mailboxes", label: "Mailboxes", icon: Inbox },
];

const CRUMB = {
  "/campaigns": "Campaigns",
  "/campaigns/new": "New campaign",
  "/leads": "Lead lists",
  "/mailboxes": "Mailboxes",
};

const COLLAPSE_KEY = "ec_nav_collapsed";

function initials(user) {
  const src = (user?.name || user?.email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).slice(0, 2) || src[0];
}

/* App chrome plus the client-side auth gate. A branded skeleton stands in
 * while the token is verified, so a signed-out visitor never sees a flash of
 * the dashboard and a signed-in one never sees a blank screen. */
export default function Shell({ children, crumb }) {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useMediaQuery("(max-width: 900px)");
  const { theme, setTheme } = useTheme();

  const [ready, setReady] = useState(false);
  const [me, setMe] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    let alive = true;
    api
      .get("/auth/me")
      .then((r) => {
        if (!alive) return;
        setMe(r.user);
        setReady(true);
      })
      .catch(() => router.replace("/login"));
    return () => {
      alive = false;
    };
  }, [router]);

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [pathname]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  }, []);

  const logout = () => {
    clearToken();
    router.replace("/login");
  };

  const here = useMemo(() => {
    if (crumb) return crumb;
    if (CRUMB[pathname]) return CRUMB[pathname];
    if (pathname.startsWith("/campaigns/")) return "Campaign";
    return "";
  }, [crumb, pathname]);

  if (!ready) return <BootSkeleton />;

  const railCollapsed = collapsed && !isMobile;
  const showLabels = !railCollapsed;

  return (
    <div className="app">
      {isMobile && drawerOpen && (
        <div className="scrim" style={{ zIndex: 55 }} onClick={() => setDrawerOpen(false)} />
      )}

      <aside
        className={`sidebar ${railCollapsed ? "collapsed" : ""} ${drawerOpen ? "open" : ""}`.trim()}
      >
        <Link href="/campaigns" className="brand" title="Pulse">
          <span className="brand-mark">
            <Send size={16} />
          </span>
          {showLabels && (
            <span style={{ minWidth: 0 }}>
              <span className="brand-name">Pulse</span>
              <span className="brand-sub">Outreach</span>
            </span>
          )}
          {isMobile && (
            <span style={{ marginLeft: "auto" }}>
              <IconButton
                icon={X}
                label="Close menu"
                onClick={(e) => {
                  e.preventDefault();
                  setDrawerOpen(false);
                }}
              />
            </span>
          )}
        </Link>

        {showLabels && <div className="navgroup">Workspace</div>}

        {NAV.map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`navlink ${active ? "active" : ""}`.trim()}
              title={railCollapsed ? n.label : undefined}
              aria-current={active ? "page" : undefined}
              style={railCollapsed ? { justifyContent: "center", padding: "10px 0" } : undefined}
            >
              <n.icon size={17} />
              {showLabels && n.label}
            </Link>
          );
        })}

        <div className="spacer" />

        {showLabels ? (
          <div className="usercard" style={{ cursor: "default" }}>
            <span className="avatar">{initials(me)}</span>
            <span style={{ minWidth: 0, flex: "1 1 auto" }}>
              <span className="small strong truncate" style={{ display: "block" }}>
                {me?.name || "Signed in"}
              </span>
              <span className="tiny faint truncate" style={{ display: "block" }}>
                {me?.email}
              </span>
            </span>
            <IconButton icon={LogOut} label="Sign out" size={16} onClick={logout} />
          </div>
        ) : (
          <div style={{ display: "grid", placeItems: "center", gap: 6 }}>
            <span className="avatar" title={me?.email}>
              {initials(me)}
            </span>
            <IconButton icon={LogOut} label="Sign out" size={16} onClick={logout} />
          </div>
        )}
      </aside>

      <div className={`mainwrap ${railCollapsed ? "wide" : ""}`.trim()}>
        <header className="topbar">
          <IconButton
            className="only-mobile"
            icon={Menu}
            label="Open menu"
            onClick={() => setDrawerOpen(true)}
          />
          <IconButton
            className="hide-sm"
            icon={PanelLeft}
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapse}
            style={isMobile ? { display: "none" } : undefined}
          />

          <nav className="crumbs" aria-label="Breadcrumb">
            <span className="hide-sm">Pulse</span>
            {here && (
              <>
                <span className="sep hide-sm">/</span>
                <span className="here truncate">{here}</span>
              </>
            )}
          </nav>

          <div style={{ flex: "1 1 auto" }} />

          <IconButton
            icon={theme === "dark" ? Sun : Moon}
            label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
        </header>

        {/* Keyed on the path so the entrance animation replays per route. */}
        <main className="main page-enter" key={pathname}>
          {children}
        </main>
      </div>
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="app">
      <aside className="sidebar" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark">
            <Send size={16} />
          </span>
          <span>
            <span className="brand-name">Pulse</span>
            <span className="brand-sub">Outreach</span>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "18px 10px" }}>
          <Skeleton h={16} w="70%" />
          <Skeleton h={16} w="85%" />
          <Skeleton h={16} w="60%" />
        </div>
      </aside>
      <div className="mainwrap">
        <header className="topbar" />
        <main className="main">
          <Skeleton h={28} w={220} style={{ marginBottom: 10 }} />
          <Skeleton h={14} w={320} style={{ marginBottom: 26 }} />
          <div className="grid c4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} h={92} r={11} />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
