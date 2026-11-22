"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Meter,
  Stat,
  TableSkeleton,
  useToast,
} from "@/components/ui";
import {
  ChevronRight,
  Megaphone,
  Pause,
  Play,
  Plus,
  Reply,
  Search,
  Send,
  Sparkles,
  Target,
  Users,
} from "@/components/icons";

const STATUS = {
  active: { kind: "ok", live: true, label: "Active" },
  paused: { kind: "warn", label: "Paused" },
  completed: { kind: "info", label: "Completed" },
  draft: { kind: "", label: "Draft" },
};

const FILTERS = ["all", "active", "paused", "draft", "completed"];

function Campaigns() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.get("/campaigns")).data);
      setErr("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Active campaigns move on their own, so refresh while the tab is visible.
  usePoll(load, 15000);

  const setStatus = async (c, status) => {
    setPending(c._id);
    try {
      await api.patch(`/campaigns/${c._id}/status`, { status });
      toast.ok(status === "active" ? `“${c.name}” is sending.` : `“${c.name}” paused.`);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPending(null);
    }
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, c) => {
          a.leads += c.leadList?.leadCount || 0;
          a.sent += c.stats?.sent || 0;
          a.replied += c.stats?.replied || 0;
          a.active += c.status === "active" ? 1 : 0;
          return a;
        },
        { leads: 0, sent: 0, replied: 0, active: 0 }
      ),
    [rows]
  );

  const counts = useMemo(() => {
    const c = { all: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!needle) return true;
      return (
        c.name.toLowerCase().includes(needle) ||
        (c.leadList?.name || "").toLowerCase().includes(needle)
      );
    });
  }, [rows, filter, q]);

  const replyRate = totals.sent ? ((totals.replied / totals.sent) * 100).toFixed(1) : "0.0";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="sub">
            Sending, replies and follow-up progress across every sequence you run.
          </p>
        </div>
        <Link className="btn primary" href="/campaigns/new">
          <Plus size={16} />
          New campaign
        </Link>
      </div>

      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}

      <div className="grid c4 stagger" style={{ marginBottom: 18 }}>
        <Stat label="Campaigns" value={rows.length} icon={Megaphone} foot={`${totals.active} sending now`} />
        <Stat label="Leads reached" value={totals.leads} icon={Users} />
        <Stat label="Delivered" value={totals.sent} icon={Send} />
        <Stat label="Reply rate" value={replyRate} unit="%" icon={Reply} accent animate={false} foot={`${totals.replied.toLocaleString()} replies`} />
      </div>

      {loading ? (
        <Card className="flush">
          <TableSkeleton rows={5} cols={5} />
        </Card>
      ) : !rows.length ? (
        <Card>
          <EmptyState
            icon={Megaphone}
            title="No campaigns yet"
            action={
              <Link className="btn primary" href="/campaigns/new">
                <Plus size={16} />
                Create your first campaign
              </Link>
            }
          >
            Connect a mailbox and upload a lead list, then build a sequence — pitch,
            follow-ups and pacing — in a few steps.
          </EmptyState>
        </Card>
      ) : (
        <Card className="flush">
          <div className="card-head">
            <div className="cluster">
              {FILTERS.filter((f) => f === "all" || counts[f]).map((f) => (
                <button
                  key={f}
                  className={`chip ${filter === f ? "on" : ""}`.trim()}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : STATUS[f].label}
                  <span className="n">{counts[f] || 0}</span>
                </button>
              ))}
            </div>
            <div className="input-affix" style={{ width: 230, maxWidth: "100%" }}>
              <Search size={15} />
              <input
                type="search"
                placeholder="Search campaigns…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search campaigns"
              />
            </div>
          </div>

          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th style={{ minWidth: 150 }}>Progress</th>
                  <th className="num">Delivered</th>
                  <th className="num">Replied</th>
                  <th className="num">Bounced</th>
                  <th className="num">Reply rate</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!shown.length && (
                  <tr>
                    <td colSpan={8}>
                      <EmptyState icon={Search} title="Nothing matches">
                        Try a different search term or status filter.
                      </EmptyState>
                    </td>
                  </tr>
                )}

                {shown.map((c) => {
                  const leads = c.leadList?.leadCount ?? 0;
                  const pct = leads ? Math.min(100, (c.stats.sent / leads) * 100) : 0;
                  const s = STATUS[c.status] || STATUS.draft;
                  return (
                    <tr key={c._id}>
                      <td>
                        <Link href={`/campaigns/${c._id}`} className="strong">
                          {c.name}
                        </Link>
                        <div className="tiny faint" style={{ marginTop: 3 }}>
                          {c.leadList?.name || "no list"} · {c.emailAccounts?.length || 0} mailbox
                          {c.emailAccounts?.length === 1 ? "" : "es"} ·{" "}
                          {c.pacing?.mode === "spread"
                            ? `over ${c.pacing.durationDays}d`
                            : `${c.sendRatePerMin}/min`}
                          {c.uniqueEmails ? (
                            <Badge kind="brand" dot={false}>
                              <Sparkles size={11} />
                              AI
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <Badge kind={s.kind} live={s.live}>
                          {s.label}
                        </Badge>
                      </td>
                      <td>
                        <Meter percent={pct} kind={pct >= 100 ? "ok" : ""} />
                        <div className="tiny faint nums" style={{ marginTop: 5 }}>
                          {c.stats.sent.toLocaleString()} / {leads.toLocaleString()}
                        </div>
                      </td>
                      <td className="num nums">{c.stats.sent.toLocaleString()}</td>
                      <td className="num nums">{c.stats.replied.toLocaleString()}</td>
                      <td className="num nums">
                        {c.stats.bounced.toLocaleString()}
                        {c.stats.other ? <span className="tiny faint"> +{c.stats.other}</span> : null}
                      </td>
                      <td className="num">
                        <span className="strong nums">{c.replyRate}%</span>
                      </td>
                      <td>
                        <div className="cluster" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                          {c.status === "active" ? (
                            <Button
                              size="sm"
                              icon={Pause}
                              loading={pending === c._id}
                              onClick={() => setStatus(c, "paused")}
                            >
                              Pause
                            </Button>
                          ) : c.status === "completed" ? null : (
                            <Button
                              size="sm"
                              variant="soft"
                              icon={Play}
                              loading={pending === c._id}
                              onClick={() => setStatus(c, "active")}
                            >
                              Start
                            </Button>
                          )}
                          <Link
                            className="btn sm ghost"
                            href={`/campaigns/${c._id}`}
                            aria-label={`Open ${c.name}`}
                          >
                            <ChevronRight size={15} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="tiny faint" style={{ marginTop: 14, display: "flex", gap: 7, alignItems: "flex-start" }}>
        <Target size={13} style={{ marginTop: 2, flex: "0 0 auto" }} />
        <span>
          <strong>Delivered</strong> means the email reached a real mailbox — it excludes
          bounces, and it is the denominator for the reply rate. Auto-replies count as
          delivered but never as replies.
        </span>
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Shell crumb="Campaigns">
      <Campaigns />
    </Shell>
  );
}
