# Extraction Notes

How this project was derived from the BetterPitch email subsystem, what was
kept, what was rewritten, and what was deliberately left behind.

**The source repository was treated as strictly read-only.** Nothing in it was
modified, moved, renamed or deleted. It remains the reference implementation;
this is an independent adaptation.

---

## 1. BetterPitch modules inspected

### Core email subsystem

| Path (relative to `backend/backend/`) | Lines |
|---|---|
| `src/models/emailCampaigns/emailAccount.js` | 63 |
| `src/models/emailCampaigns/emailCampaign.js` | 178 |
| `src/models/emailCampaigns/emailLeadList.js` | 88 |
| `src/models/emailCampaigns/emailLead.js` | 47 |
| `src/models/emailCampaigns/emailMessage.js` | 154 |
| `src/models/emailCampaigns/emailImage.js` | 31 |
| `src/controllers/emailCampaigns/accounts.js` | 112 |
| `src/controllers/emailCampaigns/leads.js` | 353 |
| `src/controllers/emailCampaigns/campaigns.js` | 569 |
| `src/controllers/emailCampaigns/aiTemplates.js` | 373 |
| `src/controllers/emailCampaigns/images.js` | 132 |
| `src/controllers/emailCampaigns/thread.js` | 259 |
| `src/routes/v1/email-campaigns/emailCampaigns.js` | 68 |
| `src/services/emailCampaigns/emailCampaignScheduler.js` | 342 |
| `src/services/emailCampaigns/runner.js` | 536 |
| `src/services/emailCampaigns/emailWorker.js` | 241 |
| `src/services/emailCampaigns/emailSender.js` | 91 |
| `src/services/emailCampaigns/mailboxLimiter.js` | 195 |
| `src/services/emailCampaigns/uniquifier.js` | 381 |
| `src/services/emailCampaigns/gmailHistorySync.js` | 278 |
| `src/services/emailCampaigns/replySync.js` | 214 |
| `src/services/emailCampaigns/classifyInbound.js` | 103 |
| `src/services/emailCampaigns/templating.js` | 98 |
| `src/services/emailCampaigns/statusSets.js` | 44 |
| `src/services/emailCampaigns/stats.js` | 50 |
| `src/services/emailCampaigns/leadCount.js` | 82 |
| `src/services/emailCampaigns/pacing.js` | 59 |
| `src/services/emailCampaigns/reaper.js` | 118 |

### Transitive dependencies traced outward from those

| Path | Why it was reached |
|---|---|
| `src/services/redis/emailQueue.js` | The queue the runner enqueues into |
| `src/services/redis/client.js` | Redis connection factory |
| `src/services/redis/lock.js` | Scheduler leader election |
| `src/services/redis/userCache.js` | Reached via `authenticate` |
| `src/services/google/oauth.js` | Consent, code exchange, refresh |
| `src/services/google/accountTokens.js` | Per-mailbox token refresh |
| `src/services/google/gmailMime.js` | RFC 2822 builder + payload parsing |
| `src/services/google/gmail.js`, `tokens.js` | Single-account legacy Gmail path |
| `src/services/billing/emailBilling.js`, `rates.js` | Credit reserve/refund in the claim path |
| `src/services/metrics/emailMetrics.js` | Analytics aggregations |
| `src/services/integrations/keys.js` | Provider API-key catalogue |
| `src/services/integrations/googleVertex.js` | Vertex client used by the rewriter |
| `src/services/integrations/cloudinary.js` | Signed image uploads |
| `src/services/mailer.js` | Transactional SMTP (not campaigns) |
| `src/utils/tokenCrypto.js` | AES-256-GCM token encryption |
| `src/middleware/authenticate/authenticate.js` | Request auth |
| `src/models/Users/Users.js` | Ownership scoping + credits |
| `src/config/env.js`, `src/app.js`, `server.js` | Boot wiring and role startup |
| `src/services/masterCampaigns/nodeExecutors.js` | Reuses `sendViaAccount` for a flow node |
| `scripts/*` (8 email-related) | Operational repair tooling |

### Frontend

| Path (relative to `frontend/frontend/`) | Lines |
|---|---|
| `app/dashboard/email-campaigns/page.jsx` | 186 |
| `app/dashboard/email-campaigns/CreateCampaignWizard.jsx` | 1,337 |
| `app/dashboard/email-campaigns/[id]/page.jsx` | 300 |
| `components/EmailThread.jsx` | 202 |
| `components/EmailMetricsView.jsx` | 173 |
| `lib/api.js`, `lib/config.js` | API client |

---

## 2. Infrastructure dependency verdicts

| Dependency | Verdict | Reasoning |
|---|---|---|
| **MongoDB** | **Required** | Holds the claim rows whose unique index IS the duplicate-send guarantee. |
| **Redis** | **Required** | Queue, leader lock, and the atomic mailbox token bucket. Without it the runner refuses to hand out work rather than lose leads. |
| **BullMQ** | **Required** (swappable) | Isolated behind `enqueueEmail()` / `createEmailWorker()`. |
| **Gmail API** | **Required** | The transport. Isolated behind `sendViaAccount()`. |
| **Google OAuth** | **Required** | How a mailbox is connected. Own client, own redirect URI. |
| **Gemini / OpenAI** | **Optional** | AI rewriting and template drafting. Both degrade cleanly when absent. |
| **Google Vertex / service account** | **Removed** | Replaced by an API-key provider. No JSON key file on disk. |
| **Cloudinary** | **Removed** | A CDN optimisation, not a requirement. Images are self-hosted. |
| **Stripe** | **Removed** | Billing is not part of an email tool. |
| **Nodemailer / SMTP** | **Removed** | Was for transactional platform mail, never for campaigns. |
| **Twilio / Telnyx** | **Removed** | Voice and SMS. Unrelated. |

---

## 3. Copied

Logic reproduced with its behaviour and reasoning intact. Renamed and re-homed,
but the algorithm is the reference implementation's.

| Now at | From | Note |
|---|---|---|
| `services/replies/classifyInbound.js` | `emailCampaigns/classifyInbound.js` | Bounce/auto-reply regex sets kept verbatim — they encode a lot of real-world DSN shapes. |
| `services/replies/statusSets.js` | `emailCampaigns/statusSets.js` | Extended with `PENDING_STATES`, `TERMINAL_STATES`, `STATUS_LABEL`, and predicates. |
| `services/rateLimit/mailboxLimiter.js` | `emailCampaigns/mailboxLimiter.js` | Both Lua scripts kept exactly, including the non-obvious `RELEASE` guard. |
| `services/campaigns/pacing.js` | `emailCampaigns/pacing.js` | Plus `jitterMs()` and a batch-overrun warning. |
| `services/campaigns/leadCount.js` | `emailCampaigns/leadCount.js` | The "never report an unverified zero" contract kept whole. |
| `services/campaigns/reaper.js` | `emailCampaigns/reaper.js` | Credit refund swapped for the quota hook. |
| `services/gmail/mime.js` | `google/gmailMime.js` | Plus optional extra headers. |
| `services/queue/client.js`, `lock.js` | `redis/client.js`, `lock.js` | Config now via the central config module. |
| `services/personalization/templating.js` | `emailCampaigns/templating.js` + `runner.js` HTML helpers | The two split copies merged into one module. |

---

## 4. Adapted

Valuable logic that carried BetterPitch-specific coupling.

| Module | What changed |
|---|---|
| **`services/campaigns/runner.js`** | Claim → reserve → enqueue preserved exactly, including every rollback path. `reserveEmailCredit` → the quota hook. Legacy template/account fallbacks dropped. |
| **`workers/emailWorker.js`** | Same idempotence gate, same park-don't-fail rate-limit handling. Now reads per-account limits; `DelayedError` no longer logged as a failure. |
| **`services/campaigns/scheduler.js`** | Both timers and the leader lock preserved. Completion now also waits for in-flight `queued` rows. |
| **`services/gmail/sender.js`** | `isRetryable()` kept exactly. Added provider dispatch and error recording onto the account. |
| **`services/replies/historySync.js`** | Same incremental algorithm. Now resolves **all** rows in a thread, not just one — a reply must stop the whole sequence. Added a page ceiling. |
| **`services/replies/replySync.js`** | Same thread analysis and outcome application. Multi-account resolution kept. |
| **`services/personalization/uniquifier.js`** | All nine validators and the circuit breaker kept. Vertex client → the provider abstraction. |
| **`services/campaigns/stats.js`** | Same in-Mongo `$group`. Added a `queued` bucket and a shared `replyRate()`. |
| **`controllers/leads.js`** | Import pipeline kept whole, including `safeFieldKey`, `throwOnValidationError` and counting accepted writes. Added a delete guard for in-use lists. |
| **`controllers/campaigns.js`** | CRUD, duplicate-row collapsing, distinct-step counting, list-swap cursor reset, CSV-injection escaping all kept. Added schedule preview and token validation. |
| **`controllers/mailboxes.js`** | Own OAuth callback instead of riding a shared Calendar callback. Added limits, revocation on delete, in-use guard. |
| **`controllers/thread.js`** | Plain-text-only inbound rule and quote splitting kept exactly. |
| **`controllers/aiTemplates.js`** | Bracket stripping and deterministic signature kept. Provider abstraction instead of two hand-rolled clients. |
| **`models/emailCampaign.js`** | Legacy parallel fields removed (see §7). |
| **`models/emailMessage.js`** | Both unique partial indexes kept, now **named** so boot can verify them. |

---

## 5. Reimplemented

| Module | Why |
|---|---|
| **`models/user.js`** | Source model carried credits, Stripe ids, per-tenant provider keys, moderation flags and a large integrations sub-document. Reduced to what ownership scoping needs. |
| **`middleware/authenticate.js`** | Source read a Redis-cached identity, rejected admin-scope tokens and enforced platform moderation. Reduced to identity resolution. |
| **`controllers/auth.js`** | Source had OTP flows and email-based reset, requiring a transactional mailer. Replaced with scrypt email+password. |
| **`services/personalization/aiProvider.js`** | Source reached models three ways; the rewriter effectively required a GCP service-account JSON on disk. One API-key interface instead. |
| **`services/quota/sendQuota.js`** | Replaces credit billing. No-op by default; keeps the rollback shape (see §6). |
| **`config/env.js`** | New: central config with fail-fast validation. |
| **`scripts/lib/indexes.js`** | New: explicit index building plus the boot-time verification. |
| **`src/server.js`** | New: role-based startup (`api` / `scheduler` / `worker`) and graceful drain. |
| **Frontend** | Rebuilt as five focused screens. The 1,337-line wizard was reduced to a 5-step flow carrying the same concepts. |

---

## 6. BetterPitch coupling removed

| Coupling | Resolution |
|---|---|
| `User.credits` + `reserveEmailCredit` / `refundEmailCredit` | Replaced by `services/quota/sendQuota.js`. **The three-step claim → reserve → enqueue shape was kept deliberately.** Deleting the middle step would have silently removed its rollback paths and left the code subtly wrong for anyone adding metering later. Default implementation always allows. |
| Stripe, credit packages, transaction ledger | Not included. |
| Shared Google Calendar OAuth callback and `t="email_acct"` state dispatch | Own callback at `/mailboxes/oauth/callback`. Calendar scopes dropped. |
| `withFullUser` middleware | Not needed. |
| Redis-backed `userCache` | Direct indexed read. |
| Admin routes, moderation, blocked users | Not included. |
| `masterCampaigns` `email` node reusing `sendViaAccount` | Not included — it bypassed the queue, the limiter and billing. |
| Voice, telephony, SMS, agents, knowledge base, playground, call recording | Not included. |
| Cloudinary signed uploads | Self-hosted images only. |
| Vertex service-account discovery from disk | API-key provider. |

---

## 7. Deliberate simplifications

Changes that go beyond decoupling. Each removes a real class of bug that only
existed to serve backwards compatibility.

1. **Legacy parallel fields dropped.** The source kept `pitch` alongside
   `pitches[]`, `emailAccountId` alongside `emailAccountIds[]`, and
   `followup.subject/html/templates` alongside `followup.steps[]` — mirrored on
   every write, with fallbacks on every read. That existed for campaigns created
   before the array forms. A new project has no such history, so only the array
   forms remain. This removes an entire "which field is authoritative?" class of
   bug.

2. **Indexes are built and verified explicitly.** The source relied on
   `autoIndex`, which swallows build errors — so the duplicate-send guarantee
   could silently not exist. Here the server **verifies both unique indexes at
   boot and refuses to start a scheduler or worker without them.**

3. **`historySync` resolves every row in a thread.** The source updated one row
   per thread. With a pitch and several follow-ups sharing a thread, a reply
   should terminate all of them.

4. **Completion waits for in-flight claims.** The source could mark a campaign
   complete while `queued` rows were still with the worker, causing the worker's
   pause check to park them repeatedly.

5. **Per-mailbox limit overrides.** Source limits were global env vars only.
   Warming a new mailbox needs a lower limit than an established one.

6. **No development fallback encryption key.** The source fell back to a
   hard-coded string when `TOKEN_ENC_KEY` was unset, producing tokens decryptable
   by anyone with the source. Here a missing key is a hard failure.

---

## 8. Behavioural guarantees preserved

Each is covered by a test (see `backend/test/`).

| Guarantee | Mechanism | Test |
|---|---|---|
| A lead never receives the same campaign-stage email twice | Unique partial index; claim-by-insert | `integration.duplicateProtection` — 20 concurrent workers → exactly 1 claim |
| At-least-once queue delivery yields exactly-once sending | Worker re-reads the row, bails unless `queued` | `integration` + code path |
| A claimed-but-undelivered row is recovered | Reaper re-enqueues after 15m, abandons at 48h | `reaper.js` |
| Campaigns sharing a mailbox cannot exceed its limit | Atomic Lua token bucket keyed by account | `verifyMailboxLimiter` path |
| A genuine reply stops follow-ups | `status === "replied"` short-circuits the sequence | `runner.js`; history sync resolves all rows |
| A bounce is not a reply | Four-way classification; delivered excludes bounces | `classifyInbound`, `retrySemantics` |
| An auto-reply is not a reply | Separate status, delivered but never counted | `classifyInbound`, `retrySemantics` |
| AI failure falls back safely | Every path returns the original copy | `uniquifier` |
| AI never alters URLs | `urlsPreserved` blocks the rewrite | `uniquifier` |
| Restart does not duplicate sends | Claim survives restart; idempotence gate | `integration` |
| A transient failure does not burn the lead | `isRetryable` + backoff + DLQ | `retrySemantics` |
| Header injection is impossible | CR/LF stripped from header values | `pacing.test.js` |

---

## 9. Known differences from BetterPitch

| Difference | Impact |
|---|---|
| No billing or credits | Sending is unmetered. `sendQuota` is the hook. |
| No legacy schema fields | Cannot read a BetterPitch database directly. Intentional — see MIGRATION_NOTES. |
| Gmail only | Same as the source, but `provider` + `sendViaAccount()` are the seam. |
| Self-hosted images | Requires a publicly reachable `PUBLIC_URL` for images to render in delivered mail. |
| Minimal auth | Email + password. No OTP, SSO or reset flow. |
| AI via API key | No Vertex service-account path. |
| Split process roles | New capability: `ROLES` env var. |
| Boot-time index verification | New: refuses to send if the guarantee is absent. |
| No open/click tracking | Same as the source. Reply, bounce and auto-reply only. |
| No unsubscribe / suppression list | Same as the source. **Add before any production cold-outreach use** — see README. |

---

## 10. Verification that nothing leaked

- No file in this project imports from, or references a path inside, the source
  repository.
- No `.env`, service-account JSON, deploy key, OAuth token or API key was copied.
  Only `.env.example` files with placeholders exist.
- The database name defaults to `email_campaigning` and the Docker ports are
  `27018` / `6380`, so this project cannot silently attach to another project's
  MongoDB or Redis.
- `npm audit`: **0 vulnerabilities** in both packages.
