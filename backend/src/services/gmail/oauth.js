// Google OAuth 2.0, implemented with plain fetch so the heavy `googleapis`
// package is not a dependency. Authorization-code flow with offline access, so
// we receive a long-lived refresh token.
//
// STANDALONE: this project uses its OWN Google Cloud OAuth client and its own
// redirect URI. It never reads tokens issued to another application -- a
// refresh token is bound to the client id that minted it, so cross-project
// reuse would not work even if it were attempted.
//
// SCOPES: only what sending and reply tracking actually need.
//   gmail.send     - required. Without it a mailbox cannot send.
//   gmail.readonly - required for reply/bounce detection. A mailbox that grants
//                    only `send` still works for sending; reply tracking is
//                    silently blind for it, which the UI surfaces.
//
// DEPLOYMENT NOTE: both gmail.* scopes are "restricted" in Google's
// classification. A published app needs OAuth verification (plus a CASA
// security assessment for gmail.readonly) before users outside your
// organization can consent. Until then, add testers under
// "OAuth consent screen -> Test users" -- they can connect immediately.

const { config } = require("../../config/env");

const SCOPE_SEND = "https://www.googleapis.com/auth/gmail.send";
const SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly";

const SCOPES = ["openid", "email", SCOPE_SEND, SCOPE_READ];

const isConfigured = () =>
  !!(config.google.clientId && config.google.clientSecret && config.google.redirectUri);

// The consent URL the browser is sent to. `state` carries our signed token so
// the callback can attribute the grant to a user.
const buildAuthUrl = (state) => {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // -> refresh token
    prompt: "consent",      // force a refresh token even on re-connect
    include_granted_scopes: "true",
    state: state || "",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

// Swap an authorization code for tokens.
const exchangeCode = async (code) => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "token exchange failed");
  }
  return {
    accessToken: data.access_token,
    // Absent when the user previously consented and Google decides not to
    // re-issue. prompt=consent normally prevents that, but the caller keeps any
    // existing token as a fallback.
    refreshToken: data.refresh_token || "",
    expiryMs: Date.now() + Number(data.expires_in || 3600) * 1000,
    // Space-separated list of what was ACTUALLY granted. A user can untick a
    // scope on the consent screen, so this is checked rather than assumed.
    scope: data.scope || "",
  };
};

// Mint a fresh access token from a stored refresh token.
const refreshAccessToken = async (refreshToken) => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "token refresh failed");
  }
  return {
    accessToken: data.access_token,
    expiryMs: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
};

// Which Google account just connected -- this becomes EmailAccount.email, and
// therefore the From address.
const fetchUserEmail = async (accessToken) => {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return res.ok ? data.email || "" : "";
  } catch {
    return "";
  }
};

// Best-effort revocation when a mailbox is disconnected, so the grant does not
// linger in the user's Google account after they removed it here.
const revokeToken = async (token) => {
  if (!token) return false;
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

module.exports = {
  SCOPES,
  SCOPE_SEND,
  SCOPE_READ,
  isConfigured,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  fetchUserEmail,
  revokeToken,
};
