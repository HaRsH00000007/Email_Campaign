"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";

function Mailboxes() {
  const params = useSearchParams();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/mailboxes");
      setRows(r.data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The OAuth callback redirects back here with the outcome in the query
  // string, since it lands in the browser rather than in a fetch.
  useEffect(() => {
    const connected = params.get("connected");
    if (connected === "1") {
      const warn = params.get("warn");
      setNote(
        warn === "no_read_scope"
          ? `Connected ${params.get("email")}, but read access was not granted -- replies and bounces cannot be detected for this mailbox. Reconnect and accept all permissions.`
          : `Connected ${params.get("email")}.`
      );
    } else if (connected === "0") {
      setErr(`Could not connect the mailbox: ${params.get("error") || "unknown error"}`);
    }
  }, [params]);

  const connect = async () => {
    try {
      const r = await api.get("/mailboxes/connect");
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveLimits = async (id, patch) => {
    try {
      await api.patch(`/mailboxes/${id}`, patch);
      await load();
      setNote("Sending limits updated.");
    } catch (e) {
      setErr(e.message);
    }
  };

  const remove = async (row) => {
    if (!confirm(`Disconnect ${row.email}? Campaigns using it will stop sending.`)) return;
    try {
      await api.del(`/mailboxes/${row._id}`);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mailboxes</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Campaigns send from these Gmail accounts. Add several and volume splits
            across them.
          </p>
        </div>
        <button className="primary" onClick={connect}>
          Connect Gmail
        </button>
      </div>

      {err && <div className="banner error">{err}</div>}
      {note && <div className="banner ok">{note}</div>}

      {loading ? (
        <div className="card empty">Loading...</div>
      ) : !rows.length ? (
        <div className="card empty">
          <p>No mailboxes connected yet.</p>
          <p className="small">
            Connect a Gmail account to start sending. For cold outreach, prefer
            several mailboxes sending a little each over one sending a lot.
          </p>
        </div>
      ) : (
        <div className="grid c2">
          {rows.map((m) => (
            <div className="card" key={m._id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <h2 style={{ wordBreak: "break-all" }}>{m.email}</h2>
                <div className="btnrow">
                  {m.connected ? (
                    <span className="pill ok">connected</span>
                  ) : (
                    <span className="pill danger">disconnected</span>
                  )}
                </div>
              </div>

              {!m.canSend && (
                <div className="banner error small">
                  Send permission missing. Reconnect this mailbox.
                </div>
              )}
              {m.canSend && !m.canReadReplies && (
                <div className="banner warn small">
                  Read permission missing -- replies and bounces cannot be detected
                  for this mailbox, so follow-ups will not stop on a reply.
                  Reconnect and accept all permissions.
                </div>
              )}
              {m.lastError && (
                <div className="banner error small">Last error: {m.lastError}</div>
              )}

              {m.usage && (
                <div className="grid c3" style={{ marginBottom: 12 }}>
                  <div className="stat">
                    <div className="k">Sent today</div>
                    <div className="v">
                      {m.usage.today}
                      <span className="tiny muted"> / {m.usage.dailyLimit}</span>
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">This hour</div>
                    <div className="v">
                      {m.usage.thisHour}
                      <span className="tiny muted"> / {m.usage.hourlyLimit}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="row">
                <div>
                  <label htmlFor={`d-${m._id}`}>Daily limit</label>
                  <input
                    id={`d-${m._id}`}
                    type="number"
                    min="1"
                    defaultValue={m.dailyLimit ?? ""}
                    placeholder="server default"
                    onBlur={(e) =>
                      saveLimits(m._id, {
                        dailyLimit: e.target.value === "" ? null : e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label htmlFor={`h-${m._id}`}>Hourly limit</label>
                  <input
                    id={`h-${m._id}`}
                    type="number"
                    min="1"
                    defaultValue={m.hourlyLimit ?? ""}
                    placeholder="server default"
                    onBlur={(e) =>
                      saveLimits(m._id, {
                        hourlyLimit: e.target.value === "" ? null : e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="tiny muted" style={{ marginTop: 6 }}>
                Gmail permits roughly 2,000/day (500 for consumer accounts). For cold
                outreach, 30-50 protects deliverability far better.
              </div>

              <hr />
              <button className="sm danger" onClick={() => remove(m)}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Mailboxes />
    </Shell>
  );
}
