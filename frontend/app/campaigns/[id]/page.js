"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { api, download } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import Conversation from "@/components/Conversation";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Meter,
  Ring,
  Skeleton,
  Stat,
  TableSkeleton,
  useToast,
} from "@/components/ui";
import {
  Activity,
  ChevronLeft,
  Clock,
  Download,
  Inbox,
  Mail,
  Pause,
  Play,
  Refresh,
  Reply,
  Search,
  Send,
  Sparkles,
  Target,
  Trash,
  Users,
} from "@/components/icons";

const PILL = {
  replied: "ok",
  sent: "info",
  bounced: "danger",
  soft_bounced: "danger",
  failed: "danger",
  auto_reply: "warn",
  queued: "",
};

const STATUS = {
  active: { kind: "ok", live: true, label: "Active" },
  paused: { kind: "warn", label: "Paused" },
  completed: { kind: "info", label: "Completed" },
  draft: { kind: "", label: "Draft" },
};

function Detail() {
  const { id } = useParams();
  const router = useRouter();
  const toast = useToast();

  const [c, setC] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/campaigns/${id}`);
      setC(r.data);
      setRecipients(r.recipients);
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  usePoll(load, 15000, [id]);

  const act = async (key, fn, msg) => {
    setBusy(key);
    try {
      await fn();
      toast.ok(msg);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };

  const counts = useMemo(
    () =>
      recipients.reduce((a, r) => {
        a[r.status] = (a[r.status] || 0) + 1;
        return a;
      }, {}),
    [recipients]
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return recipients.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!needle) return true;
      return (
        r.email.toLowerCase().includes(needle) ||
        (r.subject || "").toLowerCase().includes(needle)
      );
    });
  }, [recipients, filter, q]);

  if (!c) {
    return err ? (
      <>
        <Banner kind="error">{err}</Banner>
        <Button icon={ChevronLeft} onClick={() => router.push("/campaigns")}>
          Back to campaigns
        </Button>
      </>
    ) : (
      <>
        <Skeleton h={28} w={260} style={{ marginBottom: 10 }} />
        <Skeleton h={14} w={380} style={{ marginBottom: 24 }} />
        <div className="grid c4" style={{ marginBottom: 18 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} h={92} r={11} />
          ))}
        </div>
        <Card className="flush">
          <TableSkeleton rows={6} cols={5} />
        </Card>
      </>
    );
  }

  const s = STATUS[c.status] || STATUS.draft;
  const leads = c.leadList?.leadCount ?? 0;
  const progress = leads ? Math.min(100, (c.stats.sent / leads) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="cluster" style={{ marginBottom: 7 }}>
            <Badge kind={s.kind} live={s.live}>
              {s.label}
            </Badge>
            {c.uniqueEmails && (
              <Badge kind="brand" dot={false}>
                <Sparkles size={11} />
                AI rewrite
              </Badge>
            )}
          </div>
          <h1 className="break">{c.name}</h1>
          <p className="sub">
            {c.leadList?.name} · sending from{" "}
            {(c.emailAccounts || []).map((a) => a.email).join(", ") || "no mailbox"}
          </p>
        </div>

        <div className="cluster">
          {c.status === "active" ? (
            <Button
              icon={Pause}
              loading={busy === "status"}
              onClick={() =>
                act("status", () => api.patch(`/campaigns/${id}/status`, { status: "paused" }), "Campaign paused.")
              }
            >
              Pause
            </Button>
          ) : c.status !== "completed" ? (
            <Button
              variant="primary"
              icon={Play}
              loading={busy === "status"}
              onClick={() =>
                act("status", () => api.patch(`/campaigns/${id}/status`, { status: "active" }), "Campaign started.")
              }
            >
              Start sending
            </Button>
          ) : null}

          <Button
            icon={Refresh}
            loading={busy === "sync"}
            onClick={() => act("sync", () => api.post(`/campaigns/${id}/sync`), "Checked for new replies.")}
          >
            Check replies
          </Button>
          <Button
            icon={Send}
            loading={busy === "followup"}
            onClick={() =>
              act("followup", () => api.post(`/campaigns/${id}/followup-now`), "Follow-ups queued.")
            }
          >
            Follow up now
          </Button>
          <Button
            icon={Download}
            loading={busy === "export"}
            onClick={() =>
              act("export", () => download(`/campaigns/${id}/export?format=csv`, `${c.name}.csv`), "Export downloaded.")
            }
          >
            Export
          </Button>
        </div>
      </div>

      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}

      {/* Headline numbers ------------------------------------------------- */}
      <div className="grid c4 stagger" style={{ marginBottom: 14 }}>
        <Stat label="Leads" value={leads} icon={Users} />
        <Stat label="Delivered" value={c.stats.sent} icon={Send} foot={`${Math.round(progress)}% of list`} />
        <Stat label="Replied" value={c.stats.replied} icon={Reply} />
        <Stat
          label="Reply rate"
          value={c.replyRate}
          unit="%"
          icon={Target}
          accent
          animate={false}
        />
      </div>

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <Card>
          <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2>Sending progress</h2>
            <span className="tiny faint nums">
              {c.stats.sent.toLocaleString()} of {leads.toLocaleString()}
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <Ring percent={progress} size={62} />
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <Meter percent={progress} kind={progress >= 100 ? "ok" : ""} />
              <div className="tiny faint" style={{ marginTop: 9, lineHeight: 1.7 }}>
                <div>
                  Queued <strong className="nums">{(c.stats.queued || 0).toLocaleString()}</strong> ·
                  Follow-ups sent{" "}
                  <strong className="nums">{c.stats.followupsSent.toLocaleString()}</strong>
                </div>
                <div>
                  Wrong address <strong className="nums">{c.stats.bounced.toLocaleString()}</strong> ·
                  Auto / other <strong className="nums">{c.stats.other.toLocaleString()}</strong> ·
                  Failed <strong className="nums">{c.stats.failed.toLocaleString()}</strong>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2>Pacing</h2>
            <Badge kind="info" dot={false}>
              {c.pacing?.mode === "spread" ? "Spread" : "Fixed rate"}
            </Badge>
          </div>

          {c.pacing?.mode === "spread" ? (
            <div className="tiny muted" style={{ lineHeight: 1.85 }}>
              <div>
                <Clock size={12} /> Spread over{" "}
                <strong>{c.pacing.durationDays} day{c.pacing.durationDays === 1 ? "" : "s"}</strong>,
                a batch every <strong>{c.pacing.intervalHours}h</strong>
              </div>
              <div>
                <Activity size={12} /> Gap between sends{" "}
                <strong>
                  {c.pacing.minDelaySec}–{c.pacing.maxDelaySec}s
                </strong>
              </div>
              {c.status === "active" && c.progress && (
                <>
                  <div>
                    <Target size={12} /> Cursor at lead{" "}
                    <strong className="nums">{c.progress.nextLeadIndex.toLocaleString()}</strong> ·{" "}
                    <strong className="nums">{c.progress.batchRemaining}</strong> left in this batch
                  </div>
                  <div>
                    <Send size={12} /> Next batch{" "}
                    <strong>
                      {c.progress.nextBatchAt
                        ? new Date(c.progress.nextBatchAt).toLocaleString()
                        : "—"}
                    </strong>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="tiny muted">
              Sending continuously at <strong>{c.sendRatePerMin}/min</strong>. Spread mode is
              usually kinder to deliverability.
            </div>
          )}
        </Card>
      </div>

      {/* Recipients -------------------------------------------------------- */}
      <Card className="flush">
        <div className="card-head">
          <div className="cluster">
            <button className={`chip ${filter === "all" ? "on" : ""}`.trim()} onClick={() => setFilter("all")}>
              All <span className="n">{recipients.length}</span>
            </button>
            {Object.entries(counts).map(([k, v]) => (
              <button
                key={k}
                className={`chip ${filter === k ? "on" : ""}`.trim()}
                onClick={() => setFilter(k)}
              >
                {k.replace(/_/g, " ")} <span className="n">{v}</span>
              </button>
            ))}
          </div>
          <div className="input-affix" style={{ width: 230, maxWidth: "100%" }}>
            <Search size={15} />
            <input
              type="search"
              placeholder="Search recipients…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search recipients"
            />
          </div>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Status</th>
                <th className="hide-sm">Subject</th>
                <th className="hide-sm">Sent</th>
                <th className="num">Follow-ups</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!shown.length && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon={Inbox} title="Nothing here yet">
                      {recipients.length
                        ? "No recipient matches this filter."
                        : "Once the campaign starts, every recipient shows up here with their live status."}
                    </EmptyState>
                  </td>
                </tr>
              )}

              {shown.map((r) => (
                <tr
                  key={r.email}
                  className={`clickable ${open === r.email ? "open" : ""}`.trim()}
                  onClick={() => setOpen(r.email)}
                >
                  <td>
                    <span className="mono small break">{r.email}</span>
                  </td>
                  <td>
                    <Badge kind={PILL[r.status] || ""}>{r.statusLabel}</Badge>
                    {r.bounceReason && (
                      <div className="tiny faint" style={{ marginTop: 3 }}>
                        {r.bounceReason}
                      </div>
                    )}
                    {r.replySnippet && (
                      <div className="tiny faint truncate" style={{ maxWidth: 260, marginTop: 3 }}>
                        {r.replySnippet.slice(0, 90)}
                      </div>
                    )}
                  </td>
                  <td className="tiny hide-sm">{r.subject}</td>
                  <td className="tiny faint hide-sm" style={{ whiteSpace: "nowrap" }}>
                    {r.sentAt ? new Date(r.sentAt).toLocaleString() : "—"}
                  </td>
                  <td className="num tiny nums">
                    {r.followupsSent}/{r.followupTotal}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Mail}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(r.email);
                      }}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        title={open || ""}
        subtitle="Full conversation"
      >
        {open && <Conversation campaignId={id} email={open} />}
      </Drawer>

      <div className="cluster" style={{ marginTop: 22, justifyContent: "space-between" }}>
        <Button icon={ChevronLeft} onClick={() => router.push("/campaigns")}>
          Back to campaigns
        </Button>
        <Button variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)}>
          Delete campaign
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this campaign?"
        body={
          <>
            <strong>{c.name}</strong> and all of its message history will be removed. This
            cannot be undone.
          </>
        }
        confirmLabel="Delete campaign"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await api.del(`/campaigns/${id}`);
            toast.ok("Campaign deleted.");
            router.push("/campaigns");
          } catch (e) {
            toast.error(e.message);
            setDeleting(false);
            setConfirmDelete(false);
          }
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Shell crumb="Campaign">
      <Detail />
    </Shell>
  );
}
