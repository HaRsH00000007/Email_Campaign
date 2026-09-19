"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Banner, EmptyState, Skeleton } from "@/components/ui";
import { Inbox } from "@/components/icons";

// The full conversation with one lead.
//
// SECURITY: outbound is our own HTML and is rendered as HTML. INBOUND is
// attacker-controlled -- anyone can reply to a cold email with a payload -- so
// the API returns it as plain text and it is rendered inside <pre>, never
// through dangerouslySetInnerHTML. Do not "improve" this by rendering inbound
// HTML.
export default function Conversation({ campaignId, email }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr("");
    api
      .get(`/campaigns/${campaignId}/thread?email=${encodeURIComponent(email)}`)
      .then((r) => alive && setData(r.data))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [campaignId, email]);

  if (err) return <Banner kind="error">{err}</Banner>;

  if (!data) {
    return (
      <div className="thread">
        <div className="msg out" style={{ width: "78%" }}>
          <Skeleton h={11} w="45%" style={{ marginBottom: 9 }} />
          <Skeleton h={11} w="88%" style={{ marginBottom: 6 }} />
          <Skeleton h={11} w="72%" />
        </div>
        <div className="msg in" style={{ width: "66%" }}>
          <Skeleton h={11} w="40%" style={{ marginBottom: 9 }} />
          <Skeleton h={11} w="80%" />
        </div>
      </div>
    );
  }

  return (
    <>
      {data.degraded && (
        <Banner kind="warn">
          Showing stored previews only — the live mailbox could not be read (
          {data.degraded === "scope_not_granted"
            ? "read permission was not granted for this mailbox"
            : data.degraded}
          ).
        </Banner>
      )}

      {!data.messages.length ? (
        <EmptyState icon={Inbox} title="No messages yet">
          Nothing has been sent to this address on this campaign so far.
        </EmptyState>
      ) : (
        <div className="thread">
          {data.messages.map((m, i) =>
            m.direction === "outbound" ? (
              <article className="msg out" key={i} style={{ animationDelay: `${i * 45}ms` }}>
                <div className="meta">
                  <Badge kind="brand">
                    {m.stage === "pitch" ? "Pitch" : `Follow-up ${m.step}`}
                  </Badge>
                  <span>Us → {email}</span>
                  <span style={{ marginLeft: "auto" }}>
                    {m.at ? new Date(m.at).toLocaleString() : ""}
                  </span>
                </div>
                <div className="subject">{m.subject}</div>
                {/* Our own markup, produced by our own template pipeline. */}
                <div className="body" dangerouslySetInnerHTML={{ __html: m.html }} />
              </article>
            ) : (
              <article className="msg in" key={i} style={{ animationDelay: `${i * 45}ms` }}>
                <div className="meta">
                  <Badge kind="ok">Reply</Badge>
                  <span className="strong">{m.from || email}</span>
                  {m.partial && <Badge kind="warn">preview only</Badge>}
                  <span style={{ marginLeft: "auto" }}>
                    {m.at ? new Date(m.at).toLocaleString() : ""}
                  </span>
                </div>
                {m.subject && <div className="subject">{m.subject}</div>}
                {/* Plain text only. Never render inbound as HTML. */}
                <div className="body">
                  <pre>{m.text || m.snippet}</pre>
                </div>
                {m.quoted && (
                  <details style={{ marginTop: 9 }}>
                    <summary>Show quoted history</summary>
                    <pre className="tiny faint" style={{ whiteSpace: "pre-wrap", marginTop: 7 }}>
                      {m.quoted}
                    </pre>
                  </details>
                )}
              </article>
            )
          )}
        </div>
      )}
    </>
  );
}
