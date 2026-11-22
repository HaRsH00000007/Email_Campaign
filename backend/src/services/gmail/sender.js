// Send one email from a specific connected mailbox.
//
// This is the transport seam. Everything above it (runner, worker, scheduler)
// speaks only in terms of sendViaAccount(); nothing else in the codebase knows
// that Gmail exists. Adding SES/SMTP/Outlook means adding a sibling module and
// dispatching on EmailAccount.provider here -- no changes to the queue, the
// claim logic, or the scheduler.

const { buildRaw, b64url } = require("./mime");
const {
  loadAccountWithTokens,
  getValidAccessTokenForAccount,
  accountHasScope,
  noteAccountError,
  clearAccountError,
  SCOPE_SEND,
} = require("./accountTokens");

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Is this failure worth trying again?
//
// This distinction is the entire reason a retry queue is worth having. Treating
// every failure the same means a transient 429 costs you the lead permanently,
// exactly as if the address had never existed.
//
//   429 / 5xx / network error -> transient. Retry with backoff.
//   401 / 403                 -> auth. Retryable: a token refresh may fix it. A
//                                genuinely revoked grant exhausts its attempts
//                                and lands in the DLQ, which is correct -- that
//                                is an operator problem, not a lead problem.
//   400 / 404, and the local
//   pre-flight failures       -> permanent. The message is malformed or the
//                                account is misconfigured. Retrying cannot help.
const PERMANENT_ERRORS = new Set([
  "missing_recipient",
  "account_not_found",
  "not_connected",
  "scope_not_granted",
  "unsupported_provider",
]);

const isRetryable = ({ error, status }) => {
  if (PERMANENT_ERRORS.has(error)) return false;
  if (status == null) return true; // network / transport error
  if (status === 429) return true; // rate limited
  if (status >= 500) return true; // the provider is having a bad time
  if (status === 401 || status === 403) return true; // token may refresh
  return false; // 400 / 404 / etc -- malformed, permanent
};

// Is this Google telling us to SLOW DOWN, as opposed to telling us this one
// message is bad?
//
// The distinction drives real behaviour: a rate limit parks the entire mailbox
// on a shared cooldown so no worker retries into the same wall, whereas an
// ordinary transient failure just retries that one job. Getting it wrong in the
// permissive direction means hammering an account Google has already throttled,
// which is how a mailbox gets suspended rather than merely delayed.
//
// Google signals this three different ways depending on the surface, so check
// all three: the HTTP status, the structured `reason`, and -- for the SMTP-level
// refusals that come back as a 400 -- the prose message.
const RATE_LIMIT_REASONS = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "quotaexceeded",
  "dailylimitexceeded",
  "limitexceeded",
  "backenderror",
  "resource_exhausted",
]);

const RATE_LIMIT_PHRASES = [
  "reached a limit for sending mail",
  "sending limit exceeded",
  "user-rate limit exceeded",
  "rate limit exceeded",
  "quota exceeded",
  "try again later",
  "too many concurrent requests",
];

const isRateLimit = ({ status, reason, message }) => {
  if (status === 429) return true;
  if (reason && RATE_LIMIT_REASONS.has(String(reason).toLowerCase())) return true;
  const m = String(message || "").toLowerCase();
  return RATE_LIMIT_PHRASES.some((p) => m.includes(p));
};

// How long to wait before touching this mailbox again.
//
// Prefer what Google ACTUALLY said -- Retry-After is either a delta in seconds
// or an HTTP date -- and only fall back to our own guess when the header is
// absent. Honouring the provider's guidance is the difference between backing
// off correctly and backing off by coincidence.
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000; // 15m: a Gmail send-limit
const MAX_COOLDOWN_MS = 6 * 3600_000; //                   trip is not seconds-long

const parseRetryAfter = (headerValue) => {
  const raw = String(headerValue || "").trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_COOLDOWN_MS, Math.floor(seconds * 1000));
  }

  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(0, when - Date.now()));
  }
  return null;
};

const fail = (error, status, extra = {}) => ({
  ok: false,
  error,
  status,
  retryable: isRetryable({ error, status }),
  rateLimited: false,
  retryAfterMs: null,
  ...extra,
});

// Send. Returns { ok, id, threadId, fromEmail } or { ok:false, error, status,
// retryable }. Never throws for an expected failure -- the caller decides what
// to do with a retryable vs permanent result.
const sendViaAccount = async ({
  accountId,
  to,
  subject,
  text,
  html,
  replyTo,
  threadId,
  headers,
}) => {
  if (!to) return fail("missing_recipient");

  const account = await loadAccountWithTokens(accountId);
  if (!account) return fail("account_not_found");
  if (!account.connected) return fail("not_connected");
  if (account.provider !== "gmail") return fail("unsupported_provider");
  if (!accountHasScope(account, SCOPE_SEND)) return fail("scope_not_granted");

  let accessToken;
  try {
    accessToken = await getValidAccessTokenForAccount(account);
  } catch (e) {
    // Refresh failed: could be transient (network) or a revoked grant. Treat as
    // retryable -- a truly revoked grant exhausts its attempts and surfaces in
    // the DLQ instead of silently burning the whole lead list.
    await noteAccountError(accountId, `token refresh failed: ${e.message}`);
    return fail(e.message);
  }

  const raw = b64url(buildRaw({ from: account.email, to, subject, text, html, replyTo, headers }));
  const payload = threadId ? { raw, threadId } : { raw };

  try {
    const res = await fetch(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.error?.message || `gmail_send_${res.status}`;
      const reason = data.error?.errors?.[0]?.reason || data.error?.status;

      if (res.status === 401 || res.status === 403) {
        await noteAccountError(accountId, msg);
      }

      // A throttle is reported separately from an ordinary failure so the
      // caller can park the whole mailbox rather than retrying this one job
      // into the same wall. Note a Gmail send-limit trip arrives as 400 or 403
      // with a `reason`, NOT as a 429 -- which is why isRateLimit looks past
      // the status code, and why rateLimited forces retryable even on a status
      // we would otherwise treat as permanent.
      const rateLimited = isRateLimit({ status: res.status, reason, message: msg });
      if (rateLimited) {
        const retryAfterMs =
          parseRetryAfter(res.headers?.get?.("retry-after")) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
        return fail(msg, res.status, { rateLimited: true, retryAfterMs, retryable: true, reason });
      }

      return fail(msg, res.status, { reason });
    }

    await clearAccountError(accountId);
    return { ok: true, id: data.id, threadId: data.threadId, fromEmail: account.email };
  } catch (e) {
    return fail(e.message); // no status => transport error => retryable
  }
};

module.exports = {
  sendViaAccount,
  isRetryable,
  isRateLimit,
  parseRetryAfter,
  GMAIL_API,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
};
