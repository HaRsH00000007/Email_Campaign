"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";

const STATUS_PILL = {
  active: "ok",
  paused: "warn",
  completed: "accent",
  draft: "",
};

function Campaigns() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setRows((await api.get("/campaigns")).data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Active campaigns move on their own, so refresh while the tab is open.
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const setStatus = async (id, status) => {
    try {
      await api.patch(`/campaigns/${id}/status`, { status });
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Sending, replies and follow-up progress.
          </p>
        </div>
        <Link className="btn primary" href="/campaigns/new">
          New campaign
        </Link>
      </div>

      {err && <div className="banner error">{err}</div>}

      {loading ? (
        <div className="card empty">Loading...</div>
      ) : !rows.length ? (
        <div className="card empty">
          <p>No campaigns yet.</p>
          <p className="small">
            Connect a mailbox and upload a lead list, then create your first campaign.
          </p>
        </div>
      ) : (
        <div className="card pad0">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th className="num">Leads</th>
                  <th className="num">Delivered</th>
                  <th className="num">Replied</th>
                  <th className="num">Bounced</th>
                  <th className="num">Reply rate</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c._id}>
                    <td>
                      <Link href={`/campaigns/${c._id}`}>
                        <strong>{c.name}</strong>
                      </Link>
                      <div className="tiny muted">
                        {c.leadList?.name || "no list"} &middot;{" "}
                        {c.emailAccounts?.length || 0} mailbox
                        {c.emailAccounts?.length === 1 ? "" : "es"} &middot;{" "}
                        {c.pacing?.mode === "spread"
                          ? `over ${c.pacing.durationDays}d`
                          : `${c.sendRatePerMin}/min`}
                        {c.uniqueEmails ? " · AI rewrite" : ""}
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${STATUS_PILL[c.status] || ""}`}>{c.status}</span>
                    </td>
                    <td className="num">{(c.leadList?.leadCount ?? 0).toLocaleString()}</td>
                    <td className="num">{c.stats.sent.toLocaleString()}</td>
                    <td className="num">{c.stats.replied.toLocaleString()}</td>
                    <td className="num">
                      {c.stats.bounced.toLocaleString()}
                      {c.stats.other ? (
                        <span className="tiny muted"> +{c.stats.other}</span>
                      ) : null}
                    </td>
                    <td className="num">
                      <strong>{c.replyRate}%</strong>
                    </td>
                    <td>
                      <div className="btnrow">
                        {c.status === "active" ? (
                          <button className="sm" onClick={() => setStatus(c._id, "paused")}>
                            Pause
                          </button>
                        ) : c.status === "completed" ? null : (
                          <button className="sm" onClick={() => setStatus(c._id, "active")}>
                            Start
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="tiny muted">
        &ldquo;Delivered&rdquo; means the email reached a real mailbox &mdash; it excludes
        bounces, and it is the denominator for the reply rate. Auto-replies count as
        delivered but never as replies.
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Campaigns />
    </Shell>
  );
}
