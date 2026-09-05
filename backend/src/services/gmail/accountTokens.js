// Token handling for connected mailboxes. Each EmailAccount is its own OAuth
// grant with its own refresh token, encrypted at rest.

const { EmailAccount } = require("../../models");
const oauth = require("./oauth");
const { encrypt, decrypt } = require("../../utils/tokenCrypto");

const { SCOPE_SEND, SCOPE_READ } = oauth;

// Load an account WITH its encrypted token fields (normally select:false).
const loadAccountWithTokens = (accountId) =>
  EmailAccount.findById(accountId).select("+refreshToken +accessToken");

const accountHasScope = (account, scope) => (account?.grantedScopes || []).includes(scope);

// Record why a mailbox failed, so the UI can explain a stalled campaign without
// anyone reading logs. Best-effort: never let bookkeeping break a send.
const noteAccountError = async (accountId, message) => {
  try {
    await EmailAccount.updateOne(
      { _id: accountId },
      { lastError: String(message).slice(0, 300), lastErrorAt: new Date() }
    );
  } catch {
    /* ignore */
  }
};

const clearAccountError = async (accountId) => {
  try {
    await EmailAccount.updateOne({ _id: accountId }, { lastError: "", lastErrorAt: null });
  } catch {
    /* ignore */
  }
};

// Return a valid access token, refreshing and persisting when the current one
// is expired or within 60s of it. Throws a named error so callers can surface a
// real reason rather than a generic failure.
const getValidAccessTokenForAccount = async (account) => {
  if (!account?.connected) throw new Error("not_connected");

  const fresh =
    account.accessToken && account.expiryMs && account.expiryMs > Date.now() + 60_000;
  if (fresh) {
    const tok = decrypt(account.accessToken);
    // A decrypt miss means TOKEN_ENC_KEY changed under us. Fall through to the
    // refresh path rather than sending an empty Bearer token.
    if (tok) return tok;
  }

  const refreshToken = decrypt(account.refreshToken);
  if (!refreshToken) throw new Error("no_refresh_token");

  const { accessToken, expiryMs } = await oauth.refreshAccessToken(refreshToken);
  account.accessToken = encrypt(accessToken);
  account.expiryMs = expiryMs;
  await account.save().catch(() => {});
  return accessToken;
};

module.exports = {
  loadAccountWithTokens,
  accountHasScope,
  getValidAccessTokenForAccount,
  noteAccountError,
  clearAccountError,
  SCOPE_SEND,
  SCOPE_READ,
};
