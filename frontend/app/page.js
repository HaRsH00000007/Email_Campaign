"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";
import { Send } from "@/components/icons";

// The root is just a router: straight to campaigns when signed in, to login
// otherwise. The splash only exists so the redirect does not flash a blank page.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getToken() ? "/campaigns" : "/login");
  }, [router]);

  return (
    <div className="splash">
      <span className="brand-mark">
        <Send size={22} />
      </span>
      <span className="eyebrow">Pulse Outreach</span>
    </div>
  );
}
