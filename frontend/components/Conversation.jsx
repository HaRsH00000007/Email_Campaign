"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// The full conversation with one lead.
//
// SECURITY: outbound is our own HTML and is rendered as HTML. INBOUND is
// attacker-controlled -- anyone can reply to a cold email with a payload -- so
// the API returns it as plain text and it is rendered inside <pre>, never
// through dangerouslySetInnerHTML. Do not "improve" this by rendering inbound
// HTML.
export default function Conversation({ campaignId, email, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setData(null);
    setErr("");
    api
      .get(`/campaigns/${campaignId}/thread?email=${encodeURIComponent(email)}`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.message));
  }, [campaignId, email]);

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <h2 className="mono" style={{ wordBreak: "break-all" }}>
          {email}
        </h2>
        <button className="sm" onClick={onClose}>
          Close
        </button>
      </div>

      {err && <div className="banner error">{err}</div>}
      {!data && !err && <div className="empty">Loading conversation...</div>}

      {data?.degraded && (
        <div className="banner warn small">
          Showing stored previews only &mdash; the live mailbox could not be read (
          {data.degraded === "scope_not_granted"
            ? "read permission was not granted for this mailbox"
            : data.degraded}
          ).
        </div>
      )}

      {data?.messages.map((m, i) =>
        m.direction === "outbound" ? (
          <div className="msg out" key={i}>
            <div className="meta">
              <span>
                <strong>Us</strong> &rarr; {email}
              </span>
              <span>{m.at ? new Date(m.at).toLocaleString() : ""}</span>
              <span className="pill">{m.stage === "pitch" ? "Pitch" : `Follow-up ${m.step}`}</span>
            </div>
            <div className="small" style={{ marginBottom: 6 }}>
              <strong>{m.subject}</strong>
            </div>
            {/* Our own markup, produced by our own template pipeline. */}
            <div className="body" dangerouslySetInnerHTML={{ __html: m.html }} />
          </div>
        ) : (
          <div className="msg in" key={i}>
            <div className="meta">
              <span>
                <strong>{m.from || email}</strong>
              </span>
              <span>{m.at ? new Date(m.at).toLocaleString() : ""}</span>
              {m.partial && <span className="pill warn">preview only</span>}
            </div>
            {m.subject && (
              <div className="small" style={{ marginBottom: 6 }}>
                <strong>{m.subject}</strong>
              </div>
            )}
            {/* Plain text only. Never render inbound as HTML. */}
            <div className="body">
              <pre>{m.text || m.snippet}</pre>
            </div>
            {m.quoted && (
              <details style={{ marginTop: 8 }}>
                <summary className="tiny muted" style={{ cursor: "pointer" }}>
                  Show quoted history
                </summary>
                <pre className="tiny muted" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                  {m.quoted}
                </pre>
              </details>
            )}
          </div>
        )
      )}

      {data && !data.messages.length && <div className="empty">No messages yet.</div>}
    </div>
  );
}
