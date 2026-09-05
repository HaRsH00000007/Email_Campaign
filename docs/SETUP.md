# Setup

From nothing to a first sent email. Roughly 20 minutes, most of it waiting on
Google.

## Prerequisites

* **Node.js 20+** (`node -v`)
* **MongoDB** and **Redis** — the included `docker-compose.yml` provides both
* A **Google account** with a Google Cloud project you can create OAuth
  credentials in

---

## 1. Start MongoDB and Redis

```bash
cd email-campaigning
docker compose up -d
```

This starts MongoDB on **27018** and Redis on **6380** — deliberately not the
default ports, so it cannot collide with, or be mistaken for, another project's
database already running on this machine.

Already have them running elsewhere? Skip this and point `MONGODB_URI` /
`REDIS_URL` wherever you like — but **use a dedicated database name**.

Verify:

```bash
docker compose ps            # both should be healthy
```

---

## 2. Google Cloud: OAuth credentials

The one step that cannot be scripted.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. **APIs & Services → Library → Gmail API → Enable.**
3. **APIs & Services → OAuth consent screen:**
   * User type: **External** (or **Internal** if you have Workspace and only
     your own organisation will connect mailboxes).
   * Fill in app name, support email, developer email.
   * **Scopes** — add both:
     * `https://www.googleapis.com/auth/gmail.send`
     * `https://www.googleapis.com/auth/gmail.readonly`
   * **Test users** — add every Google account you intend to connect.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID:**
   * Application type: **Web application**
   * **Authorised redirect URIs** — add exactly:
     ```
     http://localhost:4000/api/v1/mailboxes/oauth/callback
     ```
   * Copy the **Client ID** and **Client secret**.

> **Verification.** Both `gmail.*` scopes are *restricted* in Google's
> classification. While your app is unverified only accounts listed under **Test
> users** can connect — which is fine for internal use indefinitely. Publishing
> for external users requires Google's OAuth verification, plus a CASA security
> assessment for `gmail.readonly`. Budget weeks, not days.

---

## 3. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Generate the two secrets:

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# TOKEN_ENC_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`:

```ini
PORT=4000
PUBLIC_URL=http://localhost:4000
FRONTEND_URL=http://localhost:3000

MONGODB_URI=mongodb://127.0.0.1:27018/email_campaigning
REDIS_URL=redis://127.0.0.1:6380

JWT_SECRET=<the first generated value>
TOKEN_ENC_KEY=<the second generated value>

GOOGLE_CLIENT_ID=<from step 2>
GOOGLE_CLIENT_SECRET=<from step 2>
GOOGLE_REDIRECT_URI=http://localhost:4000/api/v1/mailboxes/oauth/callback

# Optional. Without these, AI rewriting sends the original copy and template
# drafting is unavailable. Everything else works.
GEMINI_API_KEY=
OPENAI_API_KEY=

# Start low. This is deliverability, not quota.
MAILBOX_DAILY_LIMIT=50
MAILBOX_HOURLY_LIMIT=10
```

> **`TOKEN_ENC_KEY` encrypts stored OAuth tokens.** Changing it later makes every
> stored token undecryptable and every mailbox has to reconnect. Back it up.

Build indexes and confirm the duplicate-send guarantee:

```bash
npm run ensure-indexes
```

Expected:

```
  ok  uniq_pitch_per_lead
  ok  uniq_followup_step_per_lead

Duplicate protection is IN FORCE.
```

Start it:

```bash
npm run dev
```

Check health:

```bash
curl http://localhost:4000/health
```

---

## 4. Frontend

```bash
cd ../frontend
npm install
cp .env.example .env.local     # the default already points at localhost:4000
npm run dev
```

Open <http://localhost:3000>.

---

## 5. First run

1. **Create an account** — the signup form, or `npm run create-user` in the backend.
2. **Mailboxes → Connect Gmail.** Accept **both** permissions. Declining read
   access leaves the mailbox able to send but blind to replies, so follow-ups
   will not stop when someone answers. The UI warns if this happens.
3. **Lead lists → Upload.** A CSV with an `email` column; every other column
   becomes a `{{variable}}`.

   ```csv
   email,firstName,company
   jane@example.com,Jane,Acme
   ```
4. **Campaigns → New campaign.** Pick mailboxes, list, write a pitch, set pacing.
5. **Save and start sending.**

Within about 30 seconds the scheduler picks it up. Watch the backend log:

```
[scheduler] Q1 outreach: queued 1 (11 left in batch, next in 47s)
```

---

## 6. Before sending to real people

- [ ] **Send yourself a test first.** Make a one-row list with your own address.
- [ ] `PUBLIC_URL` is publicly reachable, if templates embed images — otherwise
      images will not load in delivered mail.
- [ ] `MAILBOX_DAILY_LIMIT` is set for *deliverability* (30–50), not for quota.
- [ ] A new mailbox has been warmed — start at 5–10/day and climb over weeks.
- [ ] **You have an unsubscribe mechanism.** This project does not provide one,
      and CAN-SPAM/GDPR/PECR require it. Put an opt-out line in your template and
      honour replies.
- [ ] You have a lawful basis for contacting these people.

---

## Running as separate processes

```bash
ROLES=api       npm start     # API only
ROLES=scheduler npm start     # one leader elected regardless of count
ROLES=worker    npm start     # scale these out for throughput
```

---

## Troubleshooting

**`Configuration errors -- refusing to start`**
`JWT_SECRET` or `TOKEN_ENC_KEY` is missing or too short. The message names it.

**`Critical indexes are MISSING`**
Duplicates exist from an earlier run:
```bash
npm run dedupe            # dry run
npm run dedupe -- --apply
```

**Campaign is active but nothing sends**
1. `curl localhost:4000/health` — is `redis` configured and Mongo connected?
2. Is a process with the `worker` role running? Without it, jobs queue forever.
3. Lead list `importState` must be `done`; a still-importing list reads as zero.
4. Mailbox limits — check the usage counters on the Mailboxes page.
5. Look for `[scheduler]` lines in the log; they say what happened.

**Replies never appear**
The mailbox needs `gmail.readonly`. Check the Mailboxes page for the warning and
reconnect, accepting both permissions.

**`redirect_uri_mismatch` on connect**
`GOOGLE_REDIRECT_URI` must match the value in Google Console **character for
character**, including scheme, port and trailing path.

**`Access blocked: … has not completed the Google verification process`**
Add the account under **OAuth consent screen → Test users**.

**Emails send but images do not load**
`PUBLIC_URL` points at localhost. Recipients' mail clients cannot reach it.

**Inspect dropped emails**
```bash
npm run dlq              # list
npm run dlq -- --replay  # re-enqueue (safe; cannot double-send)
```
