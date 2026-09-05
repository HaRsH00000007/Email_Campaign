"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api, getToken, clearToken } from "@/lib/api";

const NAV = [
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Lead lists" },
  { href: "/mailboxes", label: "Mailboxes" },
];

// App chrome plus the client-side auth gate. Renders nothing until the token is
// confirmed, so a signed-out visitor never sees a flash of the dashboard.
export default function Shell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api
      .get("/auth/me")
      .then((r) => {
        setMe(r.user);
        setReady(true);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  const logout = () => {
    clearToken();
    router.replace("/login");
  };

  if (!ready) return null;

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Email Campaigning</div>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={pathname.startsWith(n.href) ? "active" : ""}
          >
            {n.label}
          </Link>
        ))}
        <div className="spacer" />
        <div className="tiny muted" style={{ padding: "0 10px 8px", wordBreak: "break-all" }}>
          {me?.email}
        </div>
        <button className="sm" onClick={logout}>
          Sign out
        </button>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
