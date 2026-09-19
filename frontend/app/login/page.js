"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { Banner, Button, Field } from "@/components/ui";
import { Check, Gauge, Reply, Send, Shield, Sparkles } from "@/components/icons";

const POINTS = [
  { icon: Reply, text: "Replies and bounces detected straight from the mailbox" },
  { icon: Gauge, text: "Per-mailbox pacing that protects deliverability" },
  { icon: Sparkles, text: "AI drafting and per-recipient rewrites" },
  { icon: Shield, text: "Follow-up sequences that stop the moment someone answers" },
];

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/signup";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const r = await api.post(path, body, { noRedirect: true });
      setToken(r.token);
      router.replace("/mailboxes");
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setErr("");
  };

  return (
    <div className="auth">
      <aside className="auth-aside">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />

        <div className="brand" style={{ padding: 0, color: "#fff" }}>
          <span className="brand-mark" style={{ background: "rgba(255,255,255,0.18)", boxShadow: "none" }}>
            <Send size={16} />
          </span>
          <span>
            <span className="brand-name">Pulse</span>
            <span className="brand-sub" style={{ color: "rgba(255,255,255,0.65)" }}>
              Outreach
            </span>
          </span>
        </div>

        <div className="anim-in">
          <h2>Cold outreach that behaves like a real human sender.</h2>
          <p className="lede">
            Send from your own Gmail accounts, spread the volume the way a person would,
            and watch every reply land back in one place.
          </p>

          <div className="auth-points stagger">
            {POINTS.map((p) => (
              <div className="auth-point" key={p.text}>
                <span className="tick">
                  <Check size={12} />
                </span>
                <span>{p.text}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="tiny" style={{ opacity: 0.6 }}>
          Self-hosted. Your mailboxes, your data, your sending reputation.
        </p>
      </aside>

      <main className="auth-main">
        <div className="auth-card anim-in">
          <h1 style={{ marginBottom: 6 }}>
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="muted small" style={{ marginBottom: 22 }}>
            {mode === "login"
              ? "Sign in to pick up where your campaigns left off."
              : "Set up the first account on this workspace."}
          </p>

          <div className="seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={mode === "login" ? "on" : ""}
              onClick={() => switchMode("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              className={mode === "signup" ? "on" : ""}
              onClick={() => switchMode("signup")}
            >
              Sign up
            </button>
          </div>

          {err && <Banner kind="error">{err}</Banner>}

          <form onSubmit={submit} key={mode} className="anim-in">
            {mode === "signup" && (
              <Field label="Name" htmlFor="name">
                <input
                  id="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            )}

            <Field label="Work email" htmlFor="email">
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              hint={mode === "signup" ? "At least 10 characters." : undefined}
            >
              <input
                id="password"
                type="password"
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder="••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="block"
              loading={busy}
              style={{ marginTop: 6 }}
            >
              {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <p className="tiny faint center" style={{ marginTop: 20 }}>
            {mode === "login" ? "No account yet? " : "Already have one? "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                switchMode(mode === "login" ? "signup" : "login");
              }}
            >
              {mode === "login" ? "Create one" : "Sign in instead"}
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
