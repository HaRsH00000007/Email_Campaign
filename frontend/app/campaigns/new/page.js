"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";
import {
  Badge,
  Banner,
  Button,
  Card,
  CheckRow,
  EmptyState,
  Field,
  SectionTitle,
  Stat,
  Stepper,
  useToast,
} from "@/components/ui";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Gauge,
  Inbox,
  Mail,
  Plus,
  Send,
  Sparkles,
  Target,
  Trash,
  Users,
} from "@/components/icons";

const STEPS = ["Mailboxes", "Leads", "Templates", "Schedule", "Review"];

function Wizard() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingRefs, setLoadingRefs] = useState(true);

  const [mailboxes, setMailboxes] = useState([]);
  const [lists, setLists] = useState([]);

  // Campaign being built.
  const [name, setName] = useState("");
  const [accountIds, setAccountIds] = useState([]);
  const [listId, setListId] = useState("");
  const [pitches, setPitches] = useState([{ subject: "", html: "" }]);
  const [followupEnabled, setFollowupEnabled] = useState(true);
  const [steps, setSteps] = useState([{ delayDays: 3, delayHours: 0, subject: "", html: "" }]);
  const [uniqueEmails, setUniqueEmails] = useState(false);
  const [pacing, setPacing] = useState({
    mode: "spread",
    durationDays: 5,
    intervalHours: 1,
    minDelaySec: 60,
    maxDelaySec: 180,
  });

  const [schedule, setSchedule] = useState(null);
  const [tokenProblems, setTokenProblems] = useState([]);

  // AI drafting
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [drafts, setDrafts] = useState([]);

  useEffect(() => {
    Promise.all([api.get("/mailboxes"), api.get("/leads")])
      .then(([m, l]) => {
        setMailboxes(m.data.filter((x) => x.connected && x.canSend));
        setLists(l.data.filter((x) => x.importState === "done" && x.leadCount > 0));
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoadingRefs(false));
  }, []);

  const selectedList = useMemo(() => lists.find((l) => l._id === listId), [lists, listId]);

  // The schedule preview uses the SAME arithmetic the scheduler uses, so what
  // is shown here cannot drift from what actually happens.
  const refreshSchedule = useCallback(async () => {
    if (!listId || pacing.mode !== "spread") return setSchedule(null);
    try {
      const r = await api.post("/campaigns/preview-schedule", {
        leadListId: listId,
        pacing,
        mailboxCount: accountIds.length || 1,
      });
      setSchedule(r.data);
    } catch {
      setSchedule(null);
    }
  }, [listId, pacing, accountIds.length]);

  useEffect(() => {
    if (step === 3) refreshSchedule();
  }, [step, refreshSchedule]);

  // Warn about {{tokens}} that would render empty BEFORE anything is sent.
  const checkTokens = useCallback(async () => {
    try {
      const r = await api.post("/campaigns/validate-templates", {
        leadListId: listId,
        pitches,
        followup: { steps },
      });
      setTokenProblems(r.problems);
    } catch {
      setTokenProblems([]);
    }
  }, [listId, pitches, steps]);

  useEffect(() => {
    if (step === 4) checkTokens();
  }, [step, checkTokens]);

  const generate = async () => {
    setErr("");
    setAiBusy(true);
    try {
      const r = await api.post("/templates/generate", {
        prompt: aiPrompt,
        count: 3,
        leadListId: listId || undefined,
        withFollowup: followupEnabled,
      });
      setDrafts(r.data);
      toast.ok(`${r.data.length} drafts ready.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAiBusy(false);
    }
  };

  const useDraft = (d) => {
    setPitches((p) => {
      const next = [...p];
      const blank = next.findIndex((t) => !t.subject && !t.html);
      const entry = { subject: d.subject, html: d.html };
      if (blank >= 0) next[blank] = entry;
      else next.push(entry);
      return next;
    });
    if (d.followupHtml && followupEnabled) {
      setSteps((s) => {
        const next = [...s];
        if (next[0] && !next[0].subject && !next[0].html) {
          next[0] = { ...next[0], subject: d.followupSubject, html: d.followupHtml };
        }
        return next;
      });
    }
    toast.ok("Draft applied to a pitch variant.");
  };

  const copyToken = async (token) => {
    try {
      await navigator.clipboard.writeText(token);
      toast.ok(`Copied ${token}`);
    } catch {
      toast.error("Could not copy — select and copy it manually.");
    }
  };

  const canAdvance = () => {
    if (step === 0) return accountIds.length > 0;
    if (step === 1) return !!listId;
    if (step === 2) return !!name.trim() && pitches.some((p) => p.subject.trim() && p.html.trim());
    if (step === 3) return Number(pacing.minDelaySec) <= Number(pacing.maxDelaySec);
    return true;
  };

  const save = async (activate) => {
    setErr("");
    setBusy(true);
    try {
      const r = await api.post("/campaigns", {
        name: name.trim(),
        emailAccountIds: accountIds,
        leadListId: listId,
        pitches: pitches.filter((p) => p.subject.trim() && p.html.trim()),
        followup: { enabled: followupEnabled, steps: followupEnabled ? steps : [] },
        pacing,
        uniqueEmails,
        status: activate ? "active" : "draft",
      });
      toast.ok(activate ? "Campaign created and sending." : "Saved as a draft.");
      router.push(`/campaigns/${r.data._id}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const toggleAccount = (id) =>
    setAccountIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const validPitches = pitches.filter((p) => p.subject.trim() && p.html.trim()).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New campaign</h1>
          <p className="sub">
            Five steps: pick the senders, the audience, what you say, and how fast it goes out.
          </p>
        </div>
        <Button onClick={() => router.push("/campaigns")}>Cancel</Button>
      </div>

      <Stepper steps={STEPS} current={step} onJump={setStep} />

      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}

      {/* Wrapper keeps the sticky footer pinned to the bottom of the viewport
          even on the short steps. */}
      <div className="wizard-body">
      {/* ---- 0: mailboxes ---- */}
      {step === 0 && (
        <Card className="anim-in">
          <SectionTitle
            icon={Inbox}
            title="Which mailboxes should send?"
            hint="With more than one selected, sends rotate round-robin so each mailbox stays under its own limit."
            right={
              accountIds.length ? (
                <Badge kind="brand" dot={false}>{accountIds.length} selected</Badge>
              ) : null
            }
          />

          {loadingRefs ? (
            <div className="tiny faint">Loading mailboxes…</div>
          ) : !mailboxes.length ? (
            <EmptyState
              icon={Inbox}
              title="No usable mailbox"
              action={
                <Button variant="primary" onClick={() => router.push("/mailboxes")}>
                  Go to Mailboxes
                </Button>
              }
            >
              Connect a Gmail account with send permission before building a campaign.
            </EmptyState>
          ) : (
            mailboxes.map((m) => (
              <CheckRow
                key={m._id}
                checked={accountIds.includes(m._id)}
                onChange={() => toggleAccount(m._id)}
                title={
                  <span className="cluster">
                    {m.email}
                    {!m.canReadReplies && <Badge kind="warn">no reply tracking</Badge>}
                  </span>
                }
              >
                {m.usage
                  ? `${m.usage.today}/${m.usage.dailyLimit} sent today · ${m.usage.hourlyLimit}/hour cap`
                  : null}
              </CheckRow>
            ))
          )}
        </Card>
      )}

      {/* ---- 1: leads ---- */}
      {step === 1 && (
        <Card className="anim-in">
          <SectionTitle icon={Users} title="Who are you emailing?" />

          {loadingRefs ? (
            <div className="tiny faint">Loading lists…</div>
          ) : !lists.length ? (
            <EmptyState
              icon={Users}
              title="No ready lead lists"
              action={
                <Button variant="primary" onClick={() => router.push("/leads")}>
                  Upload a list
                </Button>
              }
            >
              Upload a CSV or Excel file under Lead lists, then come back here.
            </EmptyState>
          ) : (
            <>
              <Field label="Lead list" htmlFor="list">
                <select id="list" value={listId} onChange={(e) => setListId(e.target.value)}>
                  <option value="">Select a list…</option>
                  {lists.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name} ({l.leadCount.toLocaleString()} leads)
                    </option>
                  ))}
                </select>
              </Field>

              {selectedList && (
                <div className="anim-in">
                  <div className="grid c3" style={{ marginBottom: 16 }}>
                    <Stat label="Leads" value={selectedList.leadCount} icon={Users} accent />
                    <Stat
                      label="Variables"
                      value={selectedList.columns.length}
                      icon={Copy}
                      foot="usable in templates"
                    />
                  </div>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>
                    Available variables — click to copy
                  </div>
                  <div>
                    {selectedList.columns.map((col) => (
                      <button
                        type="button"
                        className="token"
                        key={col}
                        onClick={() => copyToken(`{{${col}}}`)}
                      >
                        {`{{${col}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* ---- 2: templates ---- */}
      {step === 2 && (
        <div className="anim-in">
          <Card>
            <Field label="Campaign name" htmlFor="cname" hint="Only you see this — it never appears in an email.">
              <input
                id="cname"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 outreach — SaaS founders"
              />
            </Field>
          </Card>

          <Card>
            <SectionTitle
              icon={Sparkles}
              title="Draft with AI"
              hint="Optional. Describe the offer and the audience; pick whichever draft reads best."
            />
            <div className="row">
              <div>
                <input
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="Intro for a recruiting tool, aimed at heads of talent"
                  onKeyDown={(e) => e.key === "Enter" && aiPrompt.trim() && generate()}
                />
              </div>
              <div className="shrink">
                <Button
                  variant="soft"
                  icon={Sparkles}
                  onClick={generate}
                  loading={aiBusy}
                  disabled={!aiPrompt.trim()}
                >
                  {aiBusy ? "Drafting…" : "Draft 3 options"}
                </Button>
              </div>
            </div>

            {drafts.length > 0 && (
              <div className="grid stagger" style={{ marginTop: 14 }}>
                {drafts.map((d, i) => (
                  <div
                    key={i}
                    className="card hoverable"
                    style={{ margin: 0, background: "var(--surface-2)" }}
                  >
                    <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                      <strong className="small">{d.subject}</strong>
                      <Badge kind="brand" dot={false}>Draft {i + 1}</Badge>
                    </div>
                    <pre
                      className="tiny muted"
                      style={{ whiteSpace: "pre-wrap", margin: "0 0 10px", maxHeight: 180, overflow: "auto" }}
                    >
                      {d.html}
                    </pre>
                    <Button size="sm" icon={Check} onClick={() => useDraft(d)}>
                      Use this draft
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle
              icon={Mail}
              title="Pitch variants"
              hint="With more than one, a variant is picked at random per lead, so the list splits for A/B testing."
              right={<Badge kind={validPitches ? "ok" : "warn"} dot={false}>{validPitches} ready</Badge>}
            />

            {pitches.map((p, i) => (
              <div
                key={i}
                style={{
                  padding: 15,
                  marginBottom: 12,
                  border: "1px solid var(--rule)",
                  borderRadius: "var(--r-md)",
                  background: "var(--surface-2)",
                }}
              >
                <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                  <span className="eyebrow">Variant {i + 1}</span>
                  {pitches.length > 1 && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={Trash}
                      onClick={() => setPitches((v) => v.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  )}
                </div>

                <Field label="Subject">
                  <input
                    type="text"
                    value={p.subject}
                    placeholder="Quick question about {{company}}"
                    onChange={(e) =>
                      setPitches((v) => v.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))
                    }
                  />
                </Field>
                <Field label="Body">
                  <textarea
                    value={p.html}
                    onChange={(e) =>
                      setPitches((v) => v.map((x, j) => (j === i ? { ...x, html: e.target.value } : x)))
                    }
                    placeholder={"Hi {{firstName}},\n\n…"}
                  />
                </Field>
              </div>
            ))}

            <Button
              icon={Plus}
              size="sm"
              onClick={() => setPitches((v) => [...v, { subject: "", html: "" }])}
            >
              Add variant
            </Button>

            {selectedList && (
              <div style={{ marginTop: 16 }}>
                <div className="eyebrow" style={{ marginBottom: 7 }}>
                  Variables from {selectedList.name}
                </div>
                {selectedList.columns.map((col) => (
                  <button type="button" className="token" key={col} onClick={() => copyToken(`{{${col}}}`)}>
                    {`{{${col}}}`}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CheckRow
              checked={followupEnabled}
              onChange={setFollowupEnabled}
              title="Send follow-ups to people who do not reply"
            >
              Each delay is measured from the previous email. The whole sequence stops the
              moment the lead replies.
            </CheckRow>

            {followupEnabled && (
              <div className="anim-in" style={{ marginTop: 14 }}>
                {steps.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 15,
                      marginBottom: 12,
                      border: "1px solid var(--rule)",
                      borderRadius: "var(--r-md)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <div className="cluster" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                      <span className="eyebrow">
                        <Clock size={11} /> Follow-up {i + 1}
                      </span>
                      {steps.length > 1 && (
                        <Button
                          size="sm"
                          variant="danger"
                          icon={Trash}
                          onClick={() => setSteps((v) => v.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      )}
                    </div>

                    <div className="row">
                      <Field label="Wait (days)">
                        <input
                          type="number"
                          min="0"
                          value={s.delayDays}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) => (j === i ? { ...x, delayDays: Number(e.target.value) } : x))
                            )
                          }
                        />
                      </Field>
                      <Field label="Hours">
                        <input
                          type="number"
                          min="0"
                          max="23"
                          value={s.delayHours}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) => (j === i ? { ...x, delayHours: Number(e.target.value) } : x))
                            )
                          }
                        />
                      </Field>
                      <Field
                        label="Subject"
                        hint="Leave blank to keep the pitch subject, so it threads."
                        className=""
                      >
                        <input
                          type="text"
                          value={s.subject}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x))
                            )
                          }
                        />
                      </Field>
                    </div>

                    <Field label="Body">
                      <textarea
                        value={s.html}
                        onChange={(e) =>
                          setSteps((v) => v.map((x, j) => (j === i ? { ...x, html: e.target.value } : x)))
                        }
                        placeholder={"Just floating this back to the top of your inbox…"}
                      />
                    </Field>
                  </div>
                ))}

                <Button
                  size="sm"
                  icon={Plus}
                  onClick={() =>
                    setSteps((v) => [...v, { delayDays: 3, delayHours: 0, subject: "", html: "" }])
                  }
                >
                  Add step
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ---- 3: schedule ---- */}
      {step === 3 && (
        <div className="anim-in">
          <Card>
            <SectionTitle
              icon={Gauge}
              title="Pacing"
              hint="Spread mode drip-feeds the list the way a person would. It is almost always the better choice."
            />
            <Field label="Mode" htmlFor="mode">
              <select
                id="mode"
                value={pacing.mode}
                onChange={(e) => setPacing({ ...pacing, mode: e.target.value })}
              >
                <option value="spread">Spread evenly over a number of days</option>
                <option value="rate">Fixed rate per minute</option>
              </select>
            </Field>

            {pacing.mode === "spread" ? (
              <div className="row">
                <Field label="Over how many days">
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={pacing.durationDays}
                    onChange={(e) => setPacing({ ...pacing, durationDays: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Batch every (hours)">
                  <input
                    type="number"
                    min="1"
                    max="24"
                    value={pacing.intervalHours}
                    onChange={(e) => setPacing({ ...pacing, intervalHours: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Min gap (sec)">
                  <input
                    type="number"
                    min="1"
                    value={pacing.minDelaySec}
                    onChange={(e) => setPacing({ ...pacing, minDelaySec: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Max gap (sec)">
                  <input
                    type="number"
                    min="1"
                    value={pacing.maxDelaySec}
                    onChange={(e) => setPacing({ ...pacing, maxDelaySec: Number(e.target.value) })}
                  />
                </Field>
              </div>
            ) : (
              <Banner kind="info">
                Rate mode sends continuously at the campaign rate. Spread mode is usually
                better for deliverability.
              </Banner>
            )}

            {Number(pacing.minDelaySec) > Number(pacing.maxDelaySec) && (
              <Banner kind="error">The minimum gap cannot be larger than the maximum gap.</Banner>
            )}
          </Card>

          {schedule && (
            <Card className="anim-in">
              <SectionTitle icon={Target} title="What this actually means" />
              <div className="grid c3 stagger">
                <Stat label="Per batch" value={schedule.leadsPerBatch} icon={Send} />
                <Stat label="Per day" value={schedule.perDay} icon={Clock} accent />
                <Stat
                  label="Per mailbox / day"
                  value={Math.round(schedule.perDayPerMailbox)}
                  icon={Inbox}
                />
              </div>

              {schedule.batchOverruns && (
                <Banner kind="warn">
                  A batch of {schedule.leadsPerBatch} takes about{" "}
                  {Math.round(schedule.batchDrainSec / 3600)}h to drain at this gap, but a new
                  one is released every {schedule.intervalHours}h. Sending will run behind the
                  stated duration — shorten the gap, lengthen the interval, or add mailboxes.
                </Banner>
              )}
            </Card>
          )}

          <Card>
            <CheckRow
              checked={uniqueEmails}
              onChange={setUniqueEmails}
              title={
                <span className="cluster">
                  Rewrite each email with AI{" "}
                  <Badge kind="brand" dot={false}>
                    <Sparkles size={11} /> AI
                  </Badge>
                </span>
              }
            >
              Your template becomes a reference; each recipient gets a reworded version with the
              same offer, CTA and links. Needs an AI key. If a rewrite fails or looks wrong, the
              original is sent instead — it can never block a send.
            </CheckRow>
          </Card>
        </div>
      )}

      {/* ---- 4: review ---- */}
      {step === 4 && (
        <div className="anim-in">
          <div className="grid c4 stagger" style={{ marginBottom: 14 }}>
            <Stat label="Leads" value={selectedList?.leadCount ?? 0} icon={Users} accent />
            <Stat label="Mailboxes" value={accountIds.length} icon={Inbox} />
            <Stat label="Pitch variants" value={validPitches} icon={Mail} />
            <Stat
              label="Follow-ups"
              value={followupEnabled ? steps.length : 0}
              icon={Clock}
              foot={followupEnabled ? "steps in sequence" : "disabled"}
            />
          </div>

          <Card>
            <SectionTitle icon={Check} title="Review before sending" />
            <table className="plain">
              <tbody>
                <tr>
                  <td className="muted small" style={{ width: 150 }}>Name</td>
                  <td className="strong">{name}</td>
                </tr>
                <tr>
                  <td className="muted small">Sending from</td>
                  <td className="small break">
                    {mailboxes
                      .filter((m) => accountIds.includes(m._id))
                      .map((m) => m.email)
                      .join(", ")}
                  </td>
                </tr>
                <tr>
                  <td className="muted small">Lead list</td>
                  <td className="small">
                    {selectedList?.name} ({selectedList?.leadCount.toLocaleString()} leads)
                  </td>
                </tr>
                <tr>
                  <td className="muted small">Pacing</td>
                  <td className="small">
                    {pacing.mode === "spread"
                      ? `Spread over ${pacing.durationDays} day${
                          pacing.durationDays === 1 ? "" : "s"
                        }, a batch every ${pacing.intervalHours}h, ${pacing.minDelaySec}–${
                          pacing.maxDelaySec
                        }s apart`
                      : "Fixed rate"}
                  </td>
                </tr>
                <tr>
                  <td className="muted small">AI rewrite</td>
                  <td>
                    {uniqueEmails ? <Badge kind="brand">On</Badge> : <Badge>Off</Badge>}
                  </td>
                </tr>
              </tbody>
            </table>

            {tokenProblems.length > 0 && (
              <Banner kind="warn">
                <div>
                  <strong>These variables are not in the lead list</strong> and will render empty:
                  <ul style={{ margin: "7px 0 0 18px", padding: 0 }}>
                    {tokenProblems.map((p, i) => (
                      <li key={i} className="small">
                        {p.where}: <span className="mono">{p.tokens.join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Banner>
            )}
          </Card>
        </div>
      )}

      </div>

      {/* ---- sticky nav ---- */}
      <div className="wizard-foot">
        {step > 0 && (
          <Button icon={ChevronLeft} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
        )}
        <div className="grow">
          <span className="tiny faint">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </span>
        </div>

        {step < STEPS.length - 1 ? (
          <Button variant="primary" disabled={!canAdvance()} onClick={() => setStep((s) => s + 1)}>
            Continue
            <ChevronRight size={16} />
          </Button>
        ) : (
          <>
            <Button onClick={() => save(false)} disabled={busy}>
              Save as draft
            </Button>
            <Button variant="primary" icon={Send} loading={busy} onClick={() => save(true)}>
              {busy ? "Starting…" : "Save and start sending"}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Shell crumb="New campaign">
      <Wizard />
    </Shell>
  );
}
