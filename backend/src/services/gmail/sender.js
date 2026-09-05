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

const fail = (error, status) => ({
  ok: false,
  error,
  status,
  retryable: isRetryable({ error, status }),
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
      if (res.status === 401 || res.status === 403) {
        await noteAccountError(accountId, msg);
      }
      return fail(msg, res.status);
    }

    await clearAccountError(accountId);
    return { ok: true, id: data.id, threadId: data.threadId, fromEmail: account.email };
  } catch (e) {
    return fail(e.message); // no status => transport error => retryable
  }
};

module.exports = { sendViaAccount, isRetryable, GMAIL_API };
