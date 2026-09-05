"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <form className="card authcard" onSubmit={submit}>
        <h1>Email Campaigning</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 18 }}>
          {mode === "login" ? "Sign in to continue." : "Create the first account."}
        </p>

        {err && <div className="banner error">{err}</div>}

        {mode === "signup" && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "signup" && <div className="tiny muted">At least 10 characters.</div>}
        </div>

        <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <hr />
        <button
          type="button"
          className="sm"
          style={{ width: "100%" }}
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setErr("");
          }}
        >
          {mode === "login" ? "Create an account" : "I already have an account"}
        </button>
      </form>
    </div>
  );
}
