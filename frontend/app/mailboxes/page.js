"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Meter,
  Skeleton,
  Stat,
  useToast,
} from "@/components/ui";
import { Alert, Inbox, Link as LinkIcon, Plus, Send, Shield, Trash } from "@/components/icons";

function usagePct(used, limit) {
  if (!limit) return 0;
  return Math.min(100, (used / limit) * 100);
}

function usageKind(pct) {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

function Mailboxes() {
  const params = useSearchParams();
  const toast = useToast();

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [toRemove, setToRemove] = useState(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.get("/mailboxes")).data);
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

  // The OAuth callback redirects back here with the outcome in the query
  // string, since it lands in the browser rather than in a fetch.
  useEffect(() => {
    const connected = params.get("connected");
    if (connected === "1") {
      const warn = params.get("warn");
      setNote(
        warn === "no_read_scope"
          ? `Connected ${params.get("email")}, but read access was not granted — replies and bounces cannot be detected for this mailbox. Reconnect and accept all permissions.`
          : `Connected ${params.get("email")}.`
      );
    } else if (connected === "0") {
      setErr(`Could not connect the mailbox: ${params.get("error") || "unknown error"}`);
    }
  }, [params]);

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await api.get("/mailboxes/connect");
      window.location.href = r.url;
    } catch (e) {
      toast.error(e.message);
      setConnecting(false);
    }
  };

  const saveLimits = async (id, patch) => {
    try {
      await api.patch(`/mailboxes/${id}`, patch);
      await load();
      toast.ok("Sending limits updated.");
    } catch (e) {
      toast.error(e.message);
    }
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, m) => {
          a.healthy += m.connected && m.canSend ? 1 : 0;
          a.today += m.usage?.today || 0;
          a.capacity += m.usage?.dailyLimit || 0;
          return a;
        },
        { healthy: 0, today: 0, capacity: 0 }
      ),
    [rows]
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mailboxes</h1>
          <p className="sub">
            Campaigns send from these Gmail accounts. Add several and volume splits across
            them, round-robin, so no single mailbox carries the whole load.
          </p>
        </div>
        <Button variant="primary" icon={Plus} loading={connecting} onClick={connect}>
          Connect Gmail
        </Button>
      </div>

      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote("")}>{note}</Banner>}

      {!loading && rows.length > 0 && (
        <div className="grid c3 stagger" style={{ marginBottom: 16 }}>
          <Stat label="Connected" value={rows.length} icon={Inbox} foot={`${totals.healthy} able to send`} />
          <Stat label="Sent today" value={totals.today} icon={Send} />
          <Stat
            label="Daily capacity"
            value={totals.capacity}
            icon={Shield}
            accent
            foot={`${Math.round(usagePct(totals.today, totals.capacity))}% used`}
          />
        </div>
      )}

      {loading ? (
        <div className="grid c2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <Skeleton h={18} w="55%" style={{ marginBottom: 14 }} />
              <Skeleton h={54} r={11} style={{ marginBottom: 14 }} />
              <Skeleton h={34} r={8} />
            </Card>
          ))}
        </div>
      ) : !rows.length ? (
        <Card>
          <EmptyState
            icon={Inbox}
            title="No mailboxes connected yet"
            action={
              <Button variant="primary" icon={LinkIcon} loading={connecting} onClick={connect}>
                Connect a Gmail account
              </Button>
            }
          >
            For cold outreach, prefer several mailboxes each sending a little over one
            mailbox sending a lot — it is the single biggest lever on deliverability.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid c2 top stagger">
          {rows.map((m) => {
            const dayPct = usagePct(m.usage?.today, m.usage?.dailyLimit);
            const hourPct = usagePct(m.usage?.thisHour, m.usage?.hourlyLimit);
            return (
              <Card className="hoverable" key={m._id}>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", gap: 11, minWidth: 0 }}>
                    <span className="avatar" aria-hidden="true">
                      {m.email.slice(0, 2)}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="strong break" style={{ fontSize: 14.5, lineHeight: 1.3 }}>
                        {m.email}
                      </div>
                      <div className="tiny faint">Gmail</div>
                    </div>
                  </div>
                  {m.connected ? (
                    <Badge kind="ok" live>
                      Connected
                    </Badge>
                  ) : (
                    <Badge kind="danger">Disconnected</Badge>
                  )}
                </div>

                {!m.canSend && (
                  <Banner kind="error">Send permission missing. Reconnect this mailbox.</Banner>
                )}
                {m.canSend && !m.canReadReplies && (
                  <Banner kind="warn">
                    Read permission missing — replies and bounces cannot be detected here, so
                    follow-ups will not stop on a reply. Reconnect and accept all permissions.
                  </Banner>
                )}
                {m.lastError && <Banner kind="error">Last error: {m.lastError}</Banner>}

                {m.usage && (
                  <div className="grid fixed2" style={{ gap: 12, marginBottom: 16 }}>
                    <div>
                      <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                        <span className="eyebrow">Today</span>
                        <span className="tiny nums strong">
                          {m.usage.today} / {m.usage.dailyLimit}
                        </span>
                      </div>
                      <Meter percent={dayPct} kind={usageKind(dayPct)} />
                    </div>
                    <div>
                      <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                        <span className="eyebrow">This hour</span>
                        <span className="tiny nums strong">
                          {m.usage.thisHour} / {m.usage.hourlyLimit}
                        </span>
                      </div>
                      <Meter percent={hourPct} kind={usageKind(hourPct)} />
                    </div>
                  </div>
                )}

                <div className="row">
                  <Field label="Daily limit" htmlFor={`d-${m._id}`}>
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
                  </Field>
                  <Field label="Hourly limit" htmlFor={`h-${m._id}`}>
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
                  </Field>
                </div>

                <p className="tiny faint" style={{ display: "flex", gap: 7, marginTop: 4 }}>
                  <Alert size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
                  <span>
                    Gmail permits roughly 2,000/day (500 for consumer accounts). For cold
                    outreach, 30–50 protects deliverability far better.
                  </span>
                </p>

                <hr />
                <Button size="sm" variant="danger" icon={Trash} onClick={() => setToRemove(m)}>
                  Disconnect
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!toRemove}
        title="Disconnect this mailbox?"
        body={
          toRemove && (
            <>
              Campaigns sending from <strong>{toRemove.email}</strong> will stop. Message
              history is kept.
            </>
          )
        }
        confirmLabel="Disconnect"
        busy={removing}
        onCancel={() => setToRemove(null)}
        onConfirm={async () => {
          setRemoving(true);
          try {
            await api.del(`/mailboxes/${toRemove._id}`);
            toast.ok("Mailbox disconnected.");
            await load();
          } catch (e) {
            toast.error(e.message);
          } finally {
            setRemoving(false);
            setToRemove(null);
          }
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Shell crumb="Mailboxes">
      {/* useSearchParams needs a Suspense boundary in the app router. */}
      <Suspense fallback={<Skeleton h={200} r={14} />}>
        <Mailboxes />
      </Suspense>
    </Shell>
  );
}
