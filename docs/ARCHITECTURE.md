# Architecture

## The shape of it

This is not an SMTP mailer. Every campaign email goes out through a Gmail
mailbox the operator has personally OAuth-connected, via
`POST /gmail/v1/users/me/messages/send`. That single decision drives everything
else: deliverability rides on Google's reputation rather than yours, and in
exchange you inherit Gmail's quotas, its thread model, and its history API —
which is also what makes cheap reply tracking possible at all.

Three loops run independently and never block each other:

```
                 ┌──────────────┐
   Browser ──────│  Express API │──────┐
                 └──────────────┘      │  config writes
                                       ▼
   ┌───────────┐  claim   ┌────────────────────┐
   │ SCHEDULER │─────────▶│      MongoDB       │◀──────┐
   │ 30s + 5s  │          │  emailmessages     │       │ outcomes
   │ leader-   │          │  emailleads  ...   │       │
   │ locked    │          └────────────────────┘       │
   └─────┬─────┘                   ▲                   │
         │ enqueue(messageId)      │ status: sent      │
         ▼                         │                   │
   ┌───────────┐            ┌──────┴──────┐    ┌───────┴────────┐
   │  BullMQ   │───────────▶│   WORKER    │    │  REPLY SYNC    │
   │  queue    │  1 job =   │  ×20        │    │ 1 call/mailbox │
   │  5 tries  │  1 email   │             │    │ /tick          │
   └───────────┘            └──────┬──────┘    └───────┬────────┘
         ▲                         │                   ▲
         │ retry w/ backoff        │ messages/send     │ inbound
         └─────────────────────────┤                   │
                                   ▼                   │
                            ┌─────────────────────────┴┐
                            │        Gmail API          │
                            └───────────────────────────┘
```

* **Scheduler** decides *who* gets emailed next and claims them. Never touches Gmail.
* **Worker** does everything slow and failure-prone: render, AI rewrite, rate check, send.
* **Reply sync** discovers replies, bounces and auto-responders.

The queue is the seam between them. That is why a 30-second AI rewrite or a
rate-limited mailbox parks one job instead of stalling every campaign.

---

## The central invariant

> **A unique partial index on `{campaignId, leadEmail}` where `stage: "pitch"`
> means the DATABASE refuses a second pitch to the same person.**

The sender never asks *"have I already sent this?"* — a question two concurrent
workers can both answer "no". It **inserts a claim row** and lets a duplicate-key
error tell it the lead was already taken.

```js
try {
  claim = await EmailMessage.create({ campaignId, leadEmail, status: "queued", ... });
} catch (e) {
  if (e.code === 11000) return { skipped: true };   // someone else owns this lead
  throw e;
}
```

A second index does the same one level down, on
`{campaignId, leadEmail, followupStep}`, so a scheduler tick and a manual
"follow up now" click cannot both deliver step *N*.

**This is verified at boot.** A unique index cannot be built over a collection
that already contains violating rows — the database rejects the build, and the
usual `autoIndex` path swallows that error, so the guarantee can silently not
exist. `src/server.js` checks both indexes by name and **refuses to start a
scheduler or worker without them**.

---

## Life of one email

Seven gates. Each has a distinct failure exit, and which exit is taken decides
whether the lead is consumed, retried, or released.

| # | Gate | Where | On failure |
|---|---|---|---|
| 1 | Read the lead cursor | runner | end of list → `done` |
| 2 | **Claim** (insert row) | runner | `E11000` → skip, advance cursor |
| 3 | **Reserve** send quota | runner | denied → delete row, **hold** cursor |
| 4 | **Enqueue** (`jobId = messageId`) | runner | no queue → delete row, refund, **hold** |
| 5 | Consume a mailbox token | worker | over quota → **park**, no attempt burned |
| 6 | Compose (+ AI rewrite) | worker | crash → retry; no template → permanent fail |
| 7 | `messages/send` | worker | retryable → backoff ×5 → DLQ |

Two details that matter:

**Pacing counters tick at enqueue, not at delivery.** They exist to stop the
scheduler over-committing within a window, so they must count what has been
*handed over*. Waiting for the worker to confirm would let the scheduler keep
enqueueing against a stale count and blow the daily limit. Reported statistics
come from the message rows, so accuracy there is unaffected.

**The claim is created before the send and only removed on rollback.** That is
what makes the whole thing safe — and also what makes the reaper necessary.

---

## Scheduler

Two timers behind a Redis leader lock.

* **Tick (30s)** — per campaign: release spread batches or claim rate-mode
  pitches, advance follow-ups, run the reply safety net, recompute stats, detect
  completion. Then, **once per mailbox**, run history sync.
* **Send loop (5s)** — drain released spread batches one email at a time,
  honouring the random inter-send gap. Each wake claims at most one email per
  campaign, so it never blocks.

The leader lock prevents *duplicated work*, not duplicate sends — the claim index
does that, and it holds even with the lock disabled.

Reply sync runs **outside** the per-campaign loop on purpose. Replies arrive in a
*mailbox*, not a campaign, and several campaigns commonly share one; syncing per
campaign would re-scan the same inbox N times.

---

## Pacing, in three stacked layers

Whichever is tightest wins.

| Layer | Scope | Mechanism | Default |
|---|---|---|---|
| Rate mode | campaign | `sendRatePerMin` → per-tick cap, bounded by `dailyLimit` | 20/min, 500/day |
| Spread mode | campaign | list ÷ (`durationDays` × batches/day), drained with random jitter | 1 day, 1h, 30–120s |
| **Mailbox bucket** | **mailbox, all campaigns** | atomic Lua over daily + hourly + spacing | 2000/day, 150/h |

Spread mode:

```
leadsPerBatch = ceil(totalLeads / (batchesPerDay × durationDays))
batchesPerDay = floor(24 / intervalHours)
```

Duration is a *target*, not a hard stop — leftover leads keep sending past it.
Missed intervals (server down) are caught up, but never beyond the leads that
remain.

**Why the mailbox layer is separate:** campaign pacing cannot throttle a mailbox.
Two campaigns sharing one each run at their own full rate, and spread mode paces
by wall-clock rather than volume, so on its own it has no daily ceiling. The
check-and-consume is a single Lua script because a read-then-write in JS races —
and the race only appears under exactly the load where exceeding the quota hurts
most.

> **2,000/day is what Gmail *permits*, not what you should *do*.** Inbox
> placement collapses well before the technical cap. For cold outreach set
> `MAILBOX_DAILY_LIMIT` around 50 and scale by adding mailboxes.

---

## Reply tracking

Two paths, sharing one classifier.

**Fast path — `historySync.js`.** Asks each mailbox *"what changed since cursor
X?"* — one API call per mailbox per tick, regardless of lifetime volume. Cost is
O(new inbound), not O(everything ever sent). Our own outbound is skipped by its
`SENT` label, and candidate threads are narrowed with one indexed query before
any message is fetched.

**Safety net — `replySync.js`.** Polls outstanding threads, least-recently-checked
first, at a small fixed budget. Gmail retains only ~7 days of history, and a
never-synced mailbox has no cursor, so anything older is invisible to the fast
path.

Both call the same `classifyInbound` and the same `applyOutcome`, which is what
stops them disagreeing about what a reply is.

### Four-way classification

Not everything arriving in a thread is a human reply.

| Type | Meaning | Delivered? | Reply? | Terminal? |
|---|---|---|---|---|
| `replied` | a genuine human reply | yes | **yes** | yes |
| `auto_reply` | out-of-office / autoresponder | **yes** | no | **no** |
| `bounced` | hard — address is wrong | no | no | yes |
| `soft_bounced` | full, blocked, temporary | no | no | yes |

Two non-obvious calls:

* **An auto-reply counts as delivered.** An autoresponder proves the mailbox
  exists. It is not terminal, because a real reply can still follow it — so the
  row keeps being polled and upgrades to `replied` if one arrives.
* **An ungradeable bounce falls to *soft*.** Branding an address "wrong" is a
  permanent judgement about a real person's contact details; it is never made
  without a definite signal.

Detection uses header and snippet signals only — `From`, `Subject`,
`Auto-Submitted`, `Content-Type`, `X-Failed-Recipients`, `Precedence` — never a
full body fetch.

**Delivered = `sent` + `replied` + `auto_reply`**, and that is the reply-rate
denominator. A bounce inflating it, or an auto-reply inflating the numerator, is
how a reply rate becomes a number nobody can trust.

---

## Follow-up sequences

Each step carries its own delay, measured from the **previous email** (the pitch
for step 0, the prior follow-up otherwise).

A lead's next step is **`priorRows.length`** — one row exists per attempted step.
That is why the enqueue rollback in the follow-up path is load-bearing in a way
the pitch path's is not: leaving a dead row behind would not merely lose that
step, it would **skip** it, marching the sequence on to *N+1* so the lead never
receives *N* at all.

The sequence stops the moment any row for that lead is `replied`. Follow-ups send
from the **same mailbox** as the pitch and into its thread, or they will not
thread in the recipient's client.

---

## AI personalization

When `uniqueEmails` is on, the stored template becomes a *reference* and a model
rewrites it per recipient — same offer, same CTA, same links, different wording.

Three hard rules, in priority order:

1. **Never block a send.** Any error, timeout or malformed output falls back to
   the original rendered copy.
2. **Never touch links.** A rewritten tracking or unsubscribe URL is worse than a
   duplicate email.
3. **Never invent facts.**

Nine validators enforce this. The output must preserve every URL, every email
address and every number (dropping a number is fine; introducing one is not);
stay within 50–200% of the original length; contain no surviving `{{token}}`;
keep the same format with no markdown; and still contain every lead field the
original used — checked on **word boundaries**, because `"Tom"` is a substring of
`"automated"` and a substring match would report a dropped name as preserved.

A **shared circuit breaker** handles rate limiting: a 429 is account-wide, so the
first one opens a cooldown during which later leads skip the model entirely.
Without it, every lead independently rediscovers the limit and its doomed retries
consume the quota the next lead needs.

Full HTML documents are never rewritten — asking a model to reword prose while
reproducing every tag byte-for-byte is a bet you lose.

---

## Failure and recovery

| Failure | Handling |
|---|---|
| Transient send error (429, 5xx, network) | Retry, exponential from 30s, up to 5 attempts |
| Auth error (401/403) | Retryable — a refresh may fix it; a revoked grant exhausts attempts and lands in the DLQ, which is correct: an operator problem, not a lead problem |
| Permanent (400/404, bad config) | Fail immediately, refund quota, dead-letter |
| Mailbox over quota | **Park** via `moveToDelayed` — no attempt burned. Rate limiting is not a failure |
| Campaign paused mid-flight | Park 60s, re-check |
| Retries exhausted | Row → `failed`, quota refunded, job → DLQ |
| **Orphaned claim** | Reaper re-enqueues after 15m; abandons at 48h with a refund and a DLQ entry |
| Process killed mid-send | Claim survives; reaper recovers it; idempotence gate prevents a double send |
| Redis unavailable | Runner refuses to claim rather than lose leads |

Re-enqueueing is always safe: `jobId` is the `messageId`, so a live job is a
no-op rather than a duplicate, and the worker re-reads the row and skips anything
not still `queued`.

---

## Data model

Six collections.

```
User ──┬── EmailAccount ────┐  (OAuth grant, encrypted tokens, history cursor)
       ├── EmailLeadList ───┼── EmailLead   (one doc per lead, dense idx)
       ├── EmailCampaign ───┴── EmailMessage (one row per email) ── sendingAccountId
       └── EmailImage
```

Two design pressures worth knowing:

**Leads are one document each.** Embedding them capped a list at roughly 145k —
a large upload built ~26MB of BSON against MongoDB's hard 16MB limit and failed
outright. `idx` is dense and stable because `progress.nextLeadIndex` is a cursor
into that ordering.

**A lead has no `status`.** A list is a reusable address book — two campaigns may
target the same one — so "already emailed" is a property of the *(campaign, lead)*
pair, and lives on `EmailMessage`.

`EmailMessage` stores **what was actually sent**: the chosen variant, the
interpolated fields, the rewritten copy. The campaign template cannot reconstruct
it, and it must survive later edits to the campaign.

---

## Process roles

```
ROLES=api,scheduler,worker   # default: one process
ROLES=api                    # API only
ROLES=scheduler              # one elected leader regardless of count
ROLES=worker                 # scale these out for throughput
```

Multiple schedulers are safe — the leader lock elects one. Multiple workers are
the *point*: they compete for jobs, and the claim index means concurrency can
never cause a duplicate send.
