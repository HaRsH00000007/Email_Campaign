"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { api } from "@/lib/api";

const STEPS = ["Mailboxes", "Leads", "Templates", "Schedule", "Review"];

function Wizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

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
      .catch((e) => setErr(e.message));
  }, []);

  const selectedList = lists.find((l) => l._id === listId);

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
    } catch (e) {
      setErr(e.message);
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
      router.push(`/campaigns/${r.data._id}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const toggleAccount = (id) =>
    setAccountIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New campaign</h1>
        </div>
        <button onClick={() => router.push("/campaigns")}>Cancel</button>
      </div>

      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`s ${i === step ? "on" : i < step ? "done" : ""}`}>
            {i + 1}. {s}
          </div>
        ))}
      </div>

      {err && <div className="banner error">{err}</div>}

      {/* ---- 0: mailboxes ---- */}
      {step === 0 && (
        <div className="card">
          <h2>Which mailboxes should send?</h2>
          {!mailboxes.length ? (
            <div className="banner warn">
              No usable mailbox. Connect a Gmail account under Mailboxes first.
            </div>
          ) : (
            <>
              {mailboxes.map((m) => (
                <label
                  key={m._id}
                  style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 8 }}
                >
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={accountIds.includes(m._id)}
                    onChange={() => toggleAccount(m._id)}
                  />
                  <span>
                    {m.email}
                    {!m.canReadReplies && (
                      <span className="pill warn" style={{ marginLeft: 8 }}>
                        no reply tracking
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <div className="tiny muted" style={{ marginTop: 10 }}>
                With more than one selected, sends rotate round-robin so each mailbox
                stays under its own limit.
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- 1: leads ---- */}
      {step === 1 && (
        <div className="card">
          <h2>Who are you emailing?</h2>
          {!lists.length ? (
            <div className="banner warn">
              No ready lead lists. Upload one under Lead lists first.
            </div>
          ) : (
            <div className="field">
              <label htmlFor="list">Lead list</label>
              <select id="list" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Select a list...</option>
                {lists.map((l) => (
                  <option key={l._id} value={l._id}>
                    {l.name} ({l.leadCount.toLocaleString()} leads)
                  </option>
                ))}
              </select>
            </div>
          )}
          {selectedList && (
            <div className="tiny muted">
              Available variables:{" "}
              <span className="mono">
                {selectedList.columns.map((c) => `{{${c}}}`).join("  ")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ---- 2: templates ---- */}
      {step === 2 && (
        <>
          <div className="card">
            <div className="field">
              <label htmlFor="cname">Campaign name</label>
              <input
                id="cname"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 outreach"
              />
            </div>
          </div>

          <div className="card">
            <h2>Draft with AI (optional)</h2>
            <div className="row">
              <div>
                <input
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="Intro for a recruiting tool, aimed at heads of talent"
                />
              </div>
              <div style={{ flex: "0 0 auto" }}>
                <button onClick={generate} disabled={aiBusy || !aiPrompt.trim()}>
                  {aiBusy ? "Drafting..." : "Draft 3"}
                </button>
              </div>
            </div>
            {drafts.map((d, i) => (
              <div key={i} className="card" style={{ marginTop: 10, marginBottom: 0 }}>
                <strong className="small">{d.subject}</strong>
                <pre className="tiny muted" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>
                  {d.html}
                </pre>
                <button className="sm" onClick={() => useDraft(d)}>
                  Use this
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Pitch variants</h2>
            <p className="tiny muted">
              With more than one, a variant is picked at random per lead so the list
              splits for A/B testing.
            </p>
            {pitches.map((p, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div className="field">
                  <label>Variant {i + 1} &mdash; subject</label>
                  <input
                    type="text"
                    value={p.subject}
                    onChange={(e) =>
                      setPitches((v) =>
                        v.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x))
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label>Body</label>
                  <textarea
                    value={p.html}
                    onChange={(e) =>
                      setPitches((v) =>
                        v.map((x, j) => (j === i ? { ...x, html: e.target.value } : x))
                      )
                    }
                    placeholder={"Hi {{firstName}},\n\n..."}
                  />
                </div>
                {pitches.length > 1 && (
                  <button
                    className="sm danger"
                    onClick={() => setPitches((v) => v.filter((_, j) => j !== i))}
                  >
                    Remove variant
                  </button>
                )}
              </div>
            ))}
            <button
              className="sm"
              onClick={() => setPitches((v) => [...v, { subject: "", html: "" }])}
            >
              Add variant
            </button>
          </div>

          <div className="card">
            <label style={{ display: "flex", gap: 9, alignItems: "center" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={followupEnabled}
                onChange={(e) => setFollowupEnabled(e.target.checked)}
              />
              <span>Send follow-ups to people who do not reply</span>
            </label>

            {followupEnabled && (
              <div style={{ marginTop: 12 }}>
                {steps.map((s, i) => (
                  <div key={i} style={{ marginBottom: 14 }}>
                    <div className="row">
                      <div>
                        <label>Wait (days)</label>
                        <input
                          type="number"
                          min="0"
                          value={s.delayDays}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) =>
                                j === i ? { ...x, delayDays: Number(e.target.value) } : x
                              )
                            )
                          }
                        />
                      </div>
                      <div>
                        <label>Hours</label>
                        <input
                          type="number"
                          min="0"
                          max="23"
                          value={s.delayHours}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) =>
                                j === i ? { ...x, delayHours: Number(e.target.value) } : x
                              )
                            )
                          }
                        />
                      </div>
                      <div style={{ flex: 3 }}>
                        <label>Subject (blank keeps the pitch subject, so it threads)</label>
                        <input
                          type="text"
                          value={s.subject}
                          onChange={(e) =>
                            setSteps((v) =>
                              v.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x))
                            )
                          }
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label>Follow-up {i + 1} body</label>
                      <textarea
                        value={s.html}
                        onChange={(e) =>
                          setSteps((v) =>
                            v.map((x, j) => (j === i ? { ...x, html: e.target.value } : x))
                          )
                        }
                      />
                    </div>
                    {steps.length > 1 && (
                      <button
                        className="sm danger"
                        onClick={() => setSteps((v) => v.filter((_, j) => j !== i))}
                      >
                        Remove step
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="sm"
                  onClick={() =>
                    setSteps((v) => [
                      ...v,
                      { delayDays: 3, delayHours: 0, subject: "", html: "" },
                    ])
                  }
                >
                  Add step
                </button>
                <div className="tiny muted" style={{ marginTop: 8 }}>
                  Each delay is measured from the previous email. The whole sequence stops
                  the moment the lead replies.
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---- 3: schedule ---- */}
      {step === 3 && (
        <>
          <div className="card">
            <h2>Pacing</h2>
            <div className="field">
              <label htmlFor="mode">Mode</label>
              <select
                id="mode"
                value={pacing.mode}
                onChange={(e) => setPacing({ ...pacing, mode: e.target.value })}
              >
                <option value="spread">Spread evenly over a number of days</option>
                <option value="rate">Fixed rate per minute</option>
              </select>
            </div>

            {pacing.mode === "spread" ? (
              <div className="row">
                <div>
                  <label>Over how many days</label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={pacing.durationDays}
                    onChange={(e) =>
                      setPacing({ ...pacing, durationDays: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label>Release a batch every (hours)</label>
                  <input
                    type="number"
                    min="1"
                    max="24"
                    value={pacing.intervalHours}
                    onChange={(e) =>
                      setPacing({ ...pacing, intervalHours: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label>Min gap (sec)</label>
                  <input
                    type="number"
                    min="1"
                    value={pacing.minDelaySec}
                    onChange={(e) =>
                      setPacing({ ...pacing, minDelaySec: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label>Max gap (sec)</label>
                  <input
                    type="number"
                    min="1"
                    value={pacing.maxDelaySec}
                    onChange={(e) =>
                      setPacing({ ...pacing, maxDelaySec: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="banner">
                Rate mode sends continuously at the campaign rate. Spread mode is
                usually better for deliverability.
              </div>
            )}
          </div>

          {schedule && (
            <div className="card">
              <h2>What this means</h2>
              <div className="grid c3">
                <div className="stat">
                  <div className="k">Per batch</div>
                  <div className="v">{schedule.leadsPerBatch}</div>
                </div>
                <div className="stat">
                  <div className="k">Per day</div>
                  <div className="v">{schedule.perDay}</div>
                </div>
                <div className="stat">
                  <div className="k">Per mailbox / day</div>
                  <div className="v">{Math.round(schedule.perDayPerMailbox)}</div>
                </div>
              </div>
              {schedule.batchOverruns && (
                <div className="banner warn" style={{ marginTop: 12 }}>
                  A batch of {schedule.leadsPerBatch} takes about{" "}
                  {Math.round(schedule.batchDrainSec / 3600)}h to drain at this gap, but a
                  new one is released every {schedule.intervalHours}h. Sending will run
                  behind the stated duration. Shorten the gap, lengthen the interval, or
                  add mailboxes.
                </div>
              )}
            </div>
          )}

          <div className="card">
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                style={{ width: "auto", marginTop: 4 }}
                checked={uniqueEmails}
                onChange={(e) => setUniqueEmails(e.target.checked)}
              />
              <span>
                <strong>Rewrite each email with AI</strong>
                <div className="tiny muted">
                  Your template becomes a reference; each recipient gets a reworded
                  version with the same offer, CTA and links. Needs an AI key. If a
                  rewrite fails or looks wrong, the original is sent instead &mdash; it can
                  never block a send.
                </div>
              </span>
            </label>
          </div>
        </>
      )}

      {/* ---- 4: review ---- */}
      {step === 4 && (
        <div className="card">
          <h2>Review</h2>
          <table>
            <tbody>
              <tr>
                <td className="muted">Name</td>
                <td>
                  <strong>{name}</strong>
                </td>
              </tr>
              <tr>
                <td className="muted">Mailboxes</td>
                <td>
                  {mailboxes
                    .filter((m) => accountIds.includes(m._id))
                    .map((m) => m.email)
                    .join(", ")}
                </td>
              </tr>
              <tr>
                <td className="muted">Lead list</td>
                <td>
                  {selectedList?.name} ({selectedList?.leadCount.toLocaleString()} leads)
                </td>
              </tr>
              <tr>
                <td className="muted">Pitch variants</td>
                <td>{pitches.filter((p) => p.subject && p.html).length}</td>
              </tr>
              <tr>
                <td className="muted">Follow-ups</td>
                <td>{followupEnabled ? `${steps.length} step(s)` : "off"}</td>
              </tr>
              <tr>
                <td className="muted">Pacing</td>
                <td>
                  {pacing.mode === "spread"
                    ? `over ${pacing.durationDays} day(s), batch every ${pacing.intervalHours}h, ${pacing.minDelaySec}-${pacing.maxDelaySec}s apart`
                    : "fixed rate"}
                </td>
              </tr>
              <tr>
                <td className="muted">AI rewrite</td>
                <td>{uniqueEmails ? "on" : "off"}</td>
              </tr>
            </tbody>
          </table>

          {tokenProblems.length > 0 && (
            <div className="banner warn" style={{ marginTop: 14 }}>
              <strong>These variables are not in the lead list</strong> and will render
              empty:
              <ul style={{ margin: "6px 0 0 18px" }}>
                {tokenProblems.map((p, i) => (
                  <li key={i} className="small">
                    {p.where}: <span className="mono">{p.tokens.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 18 }}>
        {step > 0 && <button onClick={() => setStep((s) => s - 1)}>Back</button>}
        {step < STEPS.length - 1 ? (
          <button className="primary" disabled={!canAdvance()} onClick={() => setStep((s) => s + 1)}>
            Next
          </button>
        ) : (
          <>
            <button onClick={() => save(false)} disabled={busy}>
              Save as draft
            </button>
            <button className="primary" onClick={() => save(true)} disabled={busy}>
              {busy ? "Starting..." : "Save and start sending"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Wizard />
    </Shell>
  );
}
