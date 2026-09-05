"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { api, download } from "@/lib/api";
import Conversation from "@/components/Conversation";

const PILL = {
  replied: "ok",
  sent: "accent",
  bounced: "danger",
  soft_bounced: "danger",
  failed: "danger",
  auto_reply: "warn",
  queued: "",
};

function Detail() {
  const { id } = useParams();
  const router = useRouter();
  const [c, setC] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/campaigns/${id}`);
      setC(r.data);
      setRecipients(r.recipients);
    } catch (e) {
      setErr(e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn, msg) => {
    setErr("");
    setNote("");
    try {
      await fn();
      setNote(msg);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!c) return <div className="card empty">{err || "Loading..."}</div>;

  const shown =
    filter === "all" ? recipients : recipients.filter((r) => r.status === filter);

  const counts = recipients.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1;
    return a;
  }, {});

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{c.name}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            <span className={`pill ${c.status === "active" ? "ok" : ""}`}>{c.status}</span>{" "}
            &middot; {c.leadList?.name} &middot;{" "}
            {(c.emailAccounts || []).map((a) => a.email).join(", ")}
            {c.uniqueEmails ? " · AI rewrite on" : ""}
          </p>
        </div>
        <div className="btnrow">
          {c.status === "active" ? (
            <button
              onClick={() =>
                act(() => api.patch(`/campaigns/${id}/status`, { status: "paused" }), "Paused.")
              }
            >
              Pause
            </button>
          ) : c.status !== "completed" ? (
            <button
              className="primary"
              onClick={() =>
                act(() => api.patch(`/campaigns/${id}/status`, { status: "active" }), "Started.")
              }
            >
              Start
            </button>
          ) : null}
          <button
            onClick={() =>
              act(() => api.post(`/campaigns/${id}/sync`), "Checked for new replies.")
            }
          >
            Check replies
          </button>
          <button
            onClick={() =>
              act(() => api.post(`/campaigns/${id}/followup-now`), "Follow-ups queued.")
            }
          >
            Follow up now
          </button>
          <button onClick={() => download(`/campaigns/${id}/export?format=csv`, `${c.name}.csv`)}>
            Export CSV
          </button>
        </div>
      </div>

      {err && <div className="banner error">{err}</div>}
      {note && <div className="banner ok">{note}</div>}

      <div className="grid c3" style={{ marginBottom: 14 }}>
        <div className="stat">
          <div className="k">Leads</div>
          <div className="v">{(c.leadList?.leadCount ?? 0).toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Delivered</div>
          <div className="v">{c.stats.sent.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Replied</div>
          <div className="v">{c.stats.replied.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Reply rate</div>
          <div className="v">{c.replyRate}%</div>
        </div>
        <div className="stat">
          <div className="k">Wrong address</div>
          <div className="v">{c.stats.bounced.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Other / auto</div>
          <div className="v">{c.stats.other.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Follow-ups sent</div>
          <div className="v">{c.stats.followupsSent.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Queued</div>
          <div className="v">{(c.stats.queued || 0).toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Failed</div>
          <div className="v">{c.stats.failed.toLocaleString()}</div>
        </div>
      </div>

      {c.pacing?.mode === "spread" && c.status === "active" && (
        <div className="banner small">
          Cursor at lead {c.progress.nextLeadIndex.toLocaleString()} &middot;{" "}
          {c.progress.batchRemaining} left in the current batch &middot; next batch{" "}
          {c.progress.nextBatchAt ? new Date(c.progress.nextBatchAt).toLocaleString() : "-"}
        </div>
      )}

      <div className="card pad0">
        <div style={{ padding: "10px 13px", borderBottom: "1px solid var(--rule)" }}>
          <div className="btnrow">
            <button className={`sm ${filter === "all" ? "primary" : ""}`} onClick={() => setFilter("all")}>
              All ({recipients.length})
            </button>
            {Object.entries(counts).map(([k, v]) => (
              <button
                key={k}
                className={`sm ${filter === k ? "primary" : ""}`}
                onClick={() => setFilter(k)}
              >
                {k} ({v})
              </button>
            ))}
          </div>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Status</th>
                <th>Subject</th>
                <th>Sent</th>
                <th>Follow-ups</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="empty">
                    Nothing here yet.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr
                  key={r.email}
                  className="clickable"
                  onClick={() => setOpen(open === r.email ? null : r.email)}
                >
                  <td className="mono tiny">{r.email}</td>
                  <td>
                    <span className={`pill ${PILL[r.status] || ""}`}>{r.statusLabel}</span>
                    {r.bounceReason && <div className="tiny muted">{r.bounceReason}</div>}
                    {r.replySnippet && (
                      <div className="tiny muted" style={{ maxWidth: 280 }}>
                        {r.replySnippet.slice(0, 90)}
                      </div>
                    )}
                  </td>
                  <td className="tiny">{r.subject}</td>
                  <td className="tiny muted">
                    {r.sentAt ? new Date(r.sentAt).toLocaleString() : "-"}
                  </td>
                  <td className="tiny">
                    {r.followupsSent}/{r.followupTotal}
                  </td>
                  <td>
                    <button
                      className="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(open === r.email ? null : r.email);
                      }}
                    >
                      {open === r.email ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {open && <Conversation campaignId={id} email={open} onClose={() => setOpen(null)} />}

      <div className="btnrow" style={{ marginTop: 20 }}>
        <button onClick={() => router.push("/campaigns")}>Back to campaigns</button>
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`Delete "${c.name}" and all its message history?`)) return;
            await api.del(`/campaigns/${id}`);
            router.push("/campaigns");
          }}
        >
          Delete campaign
        </button>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Detail />
    </Shell>
  );
}
