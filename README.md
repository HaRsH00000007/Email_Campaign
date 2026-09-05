# Email Campaigning

A standalone bulk email campaigning utility. Sends cold outreach through Gmail
mailboxes you connect by OAuth, tracks replies and bounces, and walks
non-responders through follow-up sequences that stop the moment someone answers.

Built as an extraction and productisation of a mature production email
subsystem, keeping the parts that exist because of real failures — and leaving
behind the platform they were embedded in.

```
Connect Gmail → Upload leads → Write templates → Set pacing → Send
                                                                ↓
                         replies ← classify ← Gmail history ← delivered
                            ↓
                   follow-ups stop
```

---

## What it does

* **Connect many Gmail mailboxes** by OAuth; campaigns rotate across them
* **Import leads** from CSV or Excel; every column becomes a `{{variable}}`
* **A/B pitch variants**, picked at random per lead
* **Follow-up sequences** with per-step delays, stopping on a genuine reply
* **Two pacing modes** — spread evenly over days, or a fixed rate
* **Per-mailbox rate limiting** that campaigns cannot bypass
* **Reply tracking** via Gmail's history API — one call per mailbox per tick
* **Four-way inbound classification** — reply / hard bounce / soft bounce / auto-reply
* **Optional AI rewriting** so no two recipients get identical copy
* **Retry with backoff and a dead-letter queue** — a rate limit never costs a lead
* **Duplicate protection enforced by the database**, not by application logic
* **CSV/XLSX activity export**, one row per email

## What it does not do

Stated plainly, because these matter before real use:

* **No unsubscribe or suppression list.** CAN-SPAM, GDPR and PECR require one.
* No open or click tracking.
* No mailbox warm-up automation, and no auto-pause on a bounce spike.
* Gmail only (the transport seam is `sendViaAccount()`).

---

## Architecture in one picture

```
   Browser ──▶ Express API ──▶ MongoDB ◀── outcomes ──┐
                                  ▲                    │
   SCHEDULER ──claim──────────────┘                    │
   30s + 5s        │                                   │
   leader-locked   └─enqueue─▶ BullMQ ─▶ WORKER ×20 ─▶ Gmail
                                            │            │
                                    mailbox token    REPLY SYNC
                                       bucket        1 call/mailbox
```

Three loops that never block each other. The **scheduler** decides who is next
and claims them; the **worker** does everything slow (render, AI rewrite, rate
check, send); **reply sync** discovers what came back. The queue is the seam —
which is why a 30-second AI rewrite parks one job instead of stalling every
campaign.

### The central invariant

> A unique partial index on `{campaignId, leadEmail}` where `stage: "pitch"`
> means the **database** refuses a second pitch to the same person.

The sender never asks *"did I already send this?"* — two concurrent workers can
both answer "no". It inserts a claim row and lets `E11000` tell it the lead was
taken. Verified by test: **20 workers racing on one lead produce exactly 1 claim
and 19 rejections.**

This is checked at boot. A unique index cannot build over a collection that
already holds duplicates, and `autoIndex` swallows that error — so the server
verifies both indexes by name and **refuses to start a scheduler or worker
without them**.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Prerequisites

* Node.js 20+
* MongoDB and Redis (`docker-compose.yml` provides both)
* A Google Cloud project with the Gmail API enabled and an OAuth client

**Redis is required for delivery** — it carries the queue, the leader lock and
the mailbox rate limiter. Without it the sender deliberately refuses to hand out
work rather than lose leads.

---

## Quick start

```bash
# 1. Infrastructure (MongoDB on 27018, Redis on 6380)
docker compose up -d

# 2. Backend
cd backend
npm install
cp .env.example .env
#    Fill in JWT_SECRET, TOKEN_ENC_KEY, and the three GOOGLE_* values.
#    Generate secrets with:
#      node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run ensure-indexes     # must report "Duplicate protection is IN FORCE"
npm run dev

# 3. Frontend
cd ../frontend
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>.

The Google Cloud OAuth setup is the one step that cannot be scripted — it is
walked through in [`docs/SETUP.md`](docs/SETUP.md).

---

## Environment variables

Backend (`backend/.env`) — see `.env.example` for the annotated full list.

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | **yes** | Use a dedicated database |
| `REDIS_URL` | **yes** | No delivery without it |
| `JWT_SECRET` | **yes** | ≥ 24 chars; server refuses to start otherwise |
| `TOKEN_ENC_KEY` | **yes** | ≥ 32 chars. **Encrypts OAuth tokens — back it up.** Changing it forces every mailbox to reconnect |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | **yes** | Redirect URI must match Google Console exactly |
| `PUBLIC_URL` | yes if using images | Must be publicly reachable, or images will not render in delivered mail |
| `FRONTEND_URL` | yes | CORS and post-OAuth redirect |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | no | AI rewriting and drafting; degrade cleanly when absent |
| `MAILBOX_DAILY_LIMIT` | no | Default 2000. **Set ~50 for cold outreach** |
| `MAILBOX_HOURLY_LIMIT` | no | Default 150 |
| `ROLES` | no | `api,scheduler,worker` |

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_API_BASE` — baked in at build
time, so rebuild after changing it.

Never commit a `.env`. Only `.env.example` belongs in git.

---

## Running

```bash
# All-in-one (development)
cd backend && npm run dev

# Split processes (production)
ROLES=api       npm start
ROLES=scheduler npm start     # a leader is elected; extras are hot spares
ROLES=worker    npm start     # scale these for throughput

# Frontend
cd frontend && npm run dev     # or: npm run build && npm start
```

Multiple workers are the point — they compete for jobs, and the claim index means
concurrency can never cause a duplicate send.

---

## Operational commands

```bash
npm run ensure-indexes        # build indexes, verify duplicate protection
npm run dedupe                # find duplicate rows (dry run)
npm run dedupe -- --apply     # remove them, then build the unique indexes
npm run dlq                   # list dead-lettered emails
npm run dlq -- --replay       # re-enqueue them (safe; cannot double-send)
npm run create-user           # create an account from the CLI
npm test                      # 67 tests
curl localhost:4000/health    # connectivity + queue depth
```

---

## Testing

```bash
cd backend && npm test
```

**67 tests, all passing.** Unit tests run offline — no database, no network, no
API keys. The integration suite runs against an in-process MongoDB
(`mongodb-memory-server`, a devDependency) and skips cleanly if it is absent.

The suite is organised around the guarantees rather than the files:

| File | Proves |
|---|---|
| `integration.duplicateProtection` | Unique indexes build; 20 racing workers → 1 claim; follow-up steps independently unique; `leadCount` never reports an unverified zero; stats roll up by delivery meaning |
| `classifyInbound` | Replies, hard/soft bounces and auto-replies are told apart |
| `uniquifier` | AI rewrites that drop a URL, invent a number, flatten a name or emit markdown are all rejected |
| `retrySemantics` | 429/5xx retry, 400/404 do not; a bounce is not delivered; an auto-reply is not terminal |
| `templating` | `{{tokens}}`, dotted headers, escaping, inline tags |
| `pacing` | Schedule arithmetic; header injection; emoji-safe encoding |

---

## Development workflow

```
backend/src/
  config/        env (fail-fast validation) + db
  models/        6 collections
  middleware/    JWT auth
  controllers/   HTTP handlers
  routes/        one router, mounted at /api/v1
  services/
    gmail/           oauth · accountTokens · mime · sender   ← transport seam
    queue/           client · lock · emailQueue              ← queue seam
    campaigns/       runner · scheduler · pacing · stats · leadCount · reaper
    personalization/ templating · aiProvider · uniquifier
    replies/         classifyInbound · statusSets · replySync · historySync
    rateLimit/       mailboxLimiter
    quota/           sendQuota                               ← metering hook
  workers/       emailWorker
  utils/         tokenCrypto · password
```

Two seams are named on purpose. `sendViaAccount()` is where a second transport
(SES, SMTP, Outlook) goes; `enqueueEmail()` / `createEmailWorker()` is where
BullMQ would be swapped for SQS or Pub/Sub. Neither change touches the claim
logic or the scheduler.

**Changing the send path?** Re-read `runner.js` first. The claim → reserve →
enqueue ordering and every rollback in it are load-bearing.

---

## Deliverability

The software will happily send faster than is wise.

* **`MAILBOX_DAILY_LIMIT` defaults to 2000 because that is what Gmail permits.
  It is not what you should do.** Inbox placement collapses well before the
  technical cap. Start at 30–50 and scale by adding mailboxes.
* Warm a new mailbox: 5–10/day, climbing over weeks.
* Spread mode with a 60–180s jitter looks far more like a person than rate mode.
* Set up SPF, DKIM and DMARC on your sending domain.
* Watch the bounce count. A rising hard-bounce rate means a bad list, and
  continuing to send from it damages the domain.
* AI rewriting helps with content fingerprinting. It does not fix a bad list, a
  cold domain, or sending too much.

---

## Security notes

* OAuth tokens are encrypted at rest with AES-256-GCM and are `select: false`.
* Inbound reply bodies are attacker-controlled and are returned as **plain text
  only**, never HTML. Do not "improve" the conversation view by rendering them.
* CR/LF is stripped from every MIME header value, so a subject cannot inject a
  header.
* CSV exports escape leading `= + - @` against formula injection.
* Image slugs are 128 bits of randomness; the public GET is unauthenticated by
  necessity — mail clients cannot send a token.
* `npm audit`: **0 vulnerabilities** in both packages.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The whole design: scheduler, queue, worker, pacing, reply tracking, failure handling |
| [`docs/SETUP.md`](docs/SETUP.md) | Step-by-step first run, including Google Cloud, and troubleshooting |
| [`docs/EXTRACTION_NOTES.md`](docs/EXTRACTION_NOTES.md) | What was copied, adapted, reimplemented or excluded, and why |
| [`docs/MIGRATION_NOTES.md`](docs/MIGRATION_NOTES.md) | Moving the project and its data; deployment |

---

## Licence

Unlicensed / private. Add one before distributing.
