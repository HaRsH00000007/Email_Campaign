// Per-MAILBOX send rate limiting. Redis-backed, atomic, multi-instance safe.
//
// WHY THIS EXISTS
//
// Campaign-level pacing (sendRatePerMin, dailyLimit, spread mode) throttles a
// CAMPAIGN. It cannot throttle a MAILBOX, and those are not the same thing:
//
//   - Two campaigns sharing one mailbox each run at their own full rate, and
//     neither knows about the other.
//   - Spread mode paces by wall-clock, not by volume, so on its own it has no
//     daily ceiling at all.
//
// Gmail caps a Workspace mailbox at roughly 2,000 sends/day (about 500 for a
// consumer account), plus shorter-window limits. Blow through that and every
// subsequent send 429s. This is the layer that makes campaign pacing safe.
//
// DELIVERABILITY vs QUOTA: 2,000/day is what Gmail PERMITS. For cold outreach
// it is emphatically not what you should DO -- inbox placement collapses well
// before the technical cap. Set MAILBOX_DAILY_LIMIT to something like 50 and
// scale by adding mailboxes, not by raising the number. Per-account overrides
// (EmailAccount.dailyLimit / .hourlyLimit) let a warming mailbox start lower.
//
// ATOMICITY: check-and-consume is a single Lua script, so N workers across N
// instances cannot collectively overshoot the cap. A read-then-write in JS
// would race, and the race only shows up under exactly the load where
// exceeding the quota hurts most.

const { getRedis, isEnabled } = require("../queue/client");
const { num } = require("../../config/env");

const DEFAULT_DAILY = num("MAILBOX_DAILY_LIMIT", 2000);
const DEFAULT_HOURLY = num("MAILBOX_HOURLY_LIMIT", 150);
const DEFAULT_SPACING_MS = Number(process.env.MAILBOX_MIN_SPACING_MS) || 0;

const dayKey = (id, now) => `mbox:${id}:d:${new Date(now).toISOString().slice(0, 10)}`;
const hourKey = (id, now) => `mbox:${id}:h:${new Date(now).toISOString().slice(0, 13)}`;
const lastKey = (id) => `mbox:${id}:last`;

// KEYS: day, hour, last
// ARGV: dailyLimit, hourlyLimit, minSpacingMs, nowMs, dayTtl, hourTtl
//
// Returns {1, 0}            -> consumed, go ahead
//         {0, retryAfterMs} -> denied, try again in retryAfterMs
//
// Counters increment ONLY on success, so a denial never burns quota.
const CONSUME = `
local dayCount  = tonumber(redis.call("GET", KEYS[1]) or "0")
local hourCount = tonumber(redis.call("GET", KEYS[2]) or "0")
local last      = tonumber(redis.call("GET", KEYS[3]) or "0")

local dailyLimit  = tonumber(ARGV[1])
local hourlyLimit = tonumber(ARGV[2])
local spacing     = tonumber(ARGV[3])
local now         = tonumber(ARGV[4])
local dayTtl      = tonumber(ARGV[5])
local hourTtl     = tonumber(ARGV[6])

if dayCount >= dailyLimit then
  return {0, dayTtl * 1000}
end

if hourCount >= hourlyLimit then
  return {0, hourTtl * 1000}
end

if spacing > 0 and last > 0 then
  local elapsed = now - last
  if elapsed < spacing then
    return {0, spacing - elapsed}
  end
end

redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], dayTtl)
redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], hourTtl)
redis.call("SET", KEYS[3], now, "EX", 86400)

return {1, 0}
`;

// Giving a slot back needs its own script. A plain DECR is WRONG here: Redis
// DECR on a missing key CREATES it at -1, with no TTL. Two ways that bites --
// the window key may already have expired (day/hour rolled over) and we would
// resurrect it as a permanent never-expiring key; and a negative count reads as
// "miles under the limit", so the mailbox sails past its carrier quota. Only
// decrement a key that exists and is above zero, and never create one.
const RELEASE = `
local n = redis.call("GET", KEYS[1])
if n and tonumber(n) > 0 then redis.call("DECR", KEYS[1]) end
local m = redis.call("GET", KEYS[2])
if m and tonumber(m) > 0 then redis.call("DECR", KEYS[2]) end
return 1
`;

// Seconds left in the current UTC day / hour. Used both as the counter TTL (so
// keys self-expire) and as the caller's retry delay when a window is full.
const secondsLeftInDay = (now) => {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((end - now) / 1000));
};

const secondsLeftInHour = (now) => {
  const d = new Date(now);
  const end = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours() + 1
  );
  return Math.max(1, Math.ceil((end - now) / 1000));
};

// Try to consume one send slot for this mailbox.
//   -> { ok: true }
//   -> { ok: false, retryAfterMs, reason }
//
// Without Redis there is no cross-instance counter to consult. We allow rather
// than block all mail -- but note that in this project the worker does not run
// without Redis at all, so that branch is only reachable in tests.
const tryConsume = async (accountId, opts = {}) => {
  if (!isEnabled()) return { ok: true, unlimited: true };

  const redis = getRedis();
  const now = Date.now();
  const daily = opts.dailyLimit || DEFAULT_DAILY;
  const hourly = opts.hourlyLimit || DEFAULT_HOURLY;
  const spacing = opts.minSpacingMs ?? DEFAULT_SPACING_MS;

  try {
    const [allowed, retryAfterMs] = await redis.eval(
      CONSUME,
      3,
      dayKey(accountId, now),
      hourKey(accountId, now),
      lastKey(accountId),
      String(daily),
      String(hourly),
      String(spacing),
      String(now),
      String(secondsLeftInDay(now)),
      String(secondsLeftInHour(now))
    );

    if (Number(allowed) === 1) return { ok: true };
    return {
      ok: false,
      retryAfterMs: Number(retryAfterMs) || 60_000,
      reason: "mailbox_rate_limited",
    };
  } catch (e) {
    // A Redis blip must not wedge all sending. Allow, and let the provider's
    // own 429 (which IS retryable) be the backstop.
    console.warn(`[mailboxLimiter] redis error, allowing send: ${e.message}`);
    return { ok: true, degraded: true };
  }
};

// Hand a slot back when we consumed a token but did not actually send.
//
// Best effort. Failing to release costs a little headroom (we under-send);
// failing the other way would over-send past the carrier quota. Prefer this.
const release = async (accountId) => {
  if (!isEnabled()) return;
  const now = Date.now();
  try {
    await getRedis().eval(RELEASE, 2, dayKey(accountId, now), hourKey(accountId, now));
  } catch {
    /* see above */
  }
};

// Current usage, for dashboards and debugging.
const usage = async (accountId, opts = {}) => {
  if (!isEnabled()) return null;
  const now = Date.now();
  try {
    const [d, h] = await getRedis().mget(dayKey(accountId, now), hourKey(accountId, now));
    return {
      today: Number(d) || 0,
      thisHour: Number(h) || 0,
      dailyLimit: opts.dailyLimit || DEFAULT_DAILY,
      hourlyLimit: opts.hourlyLimit || DEFAULT_HOURLY,
    };
  } catch {
    return null;
  }
};

// Resolve the effective limits for an account: its own overrides, else the
// server defaults.
const limitsFor = (account) => ({
  dailyLimit: account?.dailyLimit || DEFAULT_DAILY,
  hourlyLimit: account?.hourlyLimit || DEFAULT_HOURLY,
});

module.exports = {
  tryConsume,
  release,
  usage,
  limitsFor,
  DEFAULT_DAILY,
  DEFAULT_HOURLY,
};
