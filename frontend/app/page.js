"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";

// The root is just a router: straight to campaigns when signed in, to login
// otherwise. There is no marketing page to land on.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? "/campaigns" : "/login");
  }, [router]);
  return null;
}
