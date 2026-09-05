# Migration Notes

How to move this project somewhere else, and what it is and is not connected to.

---

## It is already independent

This project has **no runtime dependency on the repository it was derived from**.
Verified by:

* No file imports from, or references a path inside, that repository.
* No shared database, Redis instance, queue name, OAuth client or environment file.
* No copied credentials of any kind.
* Both packages install and build from their own `package.json`.

You can delete, move or archive the source repository and this keeps working.

---

## Moving to another directory or machine

The whole project is self-contained. To relocate:

```bash
# 1. Stop everything
docker compose down

# 2. Move it
mv email-campaigning /d/Projects/email-campaigning

# 3. Reinstall (node_modules holds absolute paths; never copy it)
cd /d/Projects/email-campaigning/backend  && rm -rf node_modules && npm install
cd ../frontend                            && rm -rf node_modules && npm install

# 4. Bring infrastructure back up
cd .. && docker compose up -d
```

Nothing else changes — no absolute paths are baked into the source.

### If you also move to a different host or port

Three settings must agree, and **one of them lives in Google Cloud Console**:

| Setting | Where | Must equal |
|---|---|---|
| `GOOGLE_REDIRECT_URI` | backend `.env` | the Console value, character for character |
| Authorised redirect URI | Google Cloud Console | the `.env` value |
| `PUBLIC_URL` | backend `.env` | how the backend is reached from the public internet |
| `FRONTEND_URL` | backend `.env` | the frontend origin (CORS + post-OAuth redirect) |
| `NEXT_PUBLIC_API_BASE` | frontend `.env.local` | how the **browser** reaches the API |

Forgetting the Console entry produces `redirect_uri_mismatch` at connect time.
`NEXT_PUBLIC_API_BASE` is baked in at **build** time — change it and rebuild.

---

## Moving the data

The database is the system of record: mailboxes and their encrypted tokens,
lists, leads, campaigns and every message row.

```bash
# Dump (adjust host/port to your setup)
mongodump --uri="mongodb://127.0.0.1:27018/email_campaigning" --out=./backup

# Restore on the target
mongorestore --uri="mongodb://<newhost>:27018" --db=email_campaigning ./backup/email_campaigning

# Then, on the target — indexes are not optional here
cd backend && npm run ensure-indexes
```

> **Carry `TOKEN_ENC_KEY` across with the data.** OAuth tokens are encrypted with
> a key derived from it. Restore the database without it and every stored token
> becomes undecryptable — every mailbox must be reconnected. This is the single
> most common way to lose a working install.

Redis holds only transient state (queued jobs, the leader lock, rate-limit
counters). It does not need migrating. Anything mid-flight is recovered by the
reaper, which re-enqueues claims that were never delivered.

---

## Deploying to a server

1. **Point at managed infrastructure** — MongoDB Atlas, Redis Cloud. Use `rediss://`
   for TLS.
2. **`NODE_ENV=production`.** Error responses stop echoing internal messages.
3. **`PUBLIC_URL` must be a real HTTPS URL** if templates embed images; email
   clients fetch them directly from the public internet.
4. **Update the Google Console redirect URI** to the production callback.
5. **Run `npm run ensure-indexes` as part of the deploy**, before traffic. The
   server refuses to start a scheduler or worker without the unique indexes, but
   catching it in the deploy is better than at boot.
6. **Split the roles:**

   ```
   web     ROLES=api        (behind the load balancer, scale on request volume)
   sched   ROLES=scheduler  (a leader is elected; extras are hot spares)
   worker  ROLES=worker     (scale on send throughput)
   ```

7. **Health check** — `GET /health` returns 503 until Mongo is connected, and
   reports queue depth.
8. **Graceful shutdown** — `SIGTERM` drains the worker first so an in-flight send
   completes and marks its row rather than becoming an orphaned claim.

---

## Importing data from BetterPitch

**There is no migration path, and adopting one is not recommended.**

The schemas deliberately diverged: this project dropped the parallel legacy
fields (`pitch`, `emailAccountId`, `followup.subject/html/templates`) that the
source maintained alongside the array forms. See EXTRACTION_NOTES §7.

More importantly, **OAuth tokens cannot be transferred**. A refresh token is
bound to the OAuth client that minted it. This project uses its own Google Cloud
client, so a token issued to the other application would be rejected even if it
were copied. Mailboxes must be connected here, once.

If you genuinely need historical campaign data, export it rather than migrating
it: BetterPitch has a per-campaign CSV/XLSX activity export. That gives you the
record without coupling the two systems.

Lead lists move cleanly — re-upload the original CSVs.

---

## Backups

| What | How | Frequency |
|---|---|---|
| Database | `mongodump` | Daily |
| **`TOKEN_ENC_KEY`** | **Secret manager. Not in git.** | Once, permanently |
| `JWT_SECRET` | Secret manager | Once (rotating logs everyone out) |
| Google OAuth client secret | Secret manager | Once |

A database backup without `TOKEN_ENC_KEY` is only a partial backup.

---

## What is intentionally not here

Worth knowing before production use:

* **No unsubscribe or suppression list.** Required by CAN-SPAM, GDPR and PECR.
  Put an opt-out in your templates and honour replies manually, or build it.
* **No open or click tracking.** Reply, bounce and auto-reply only.
* **No mailbox warm-up automation.** Raise `dailyLimit` by hand over weeks.
* **No automatic pause on a bounce spike.** Watch the campaign's bounce count.
* **Gmail only.** `EmailAccount.provider` and `sendViaAccount()` are the seam for
  a second transport.
