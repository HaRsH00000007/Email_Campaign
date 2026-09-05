// Redis distributed lock, used for scheduler leader election. Without it, two
// backend instances pointed at the same Mongo would each tick every active
// campaign.
//
// (The unique-index claim would still prevent duplicate SENDS -- that guarantee
// does not depend on this lock. What the lock prevents is the wasted work and
// the pacing counters being advanced twice.)
//
// Pattern:
//   token = acquireLock(key, ttlMs)   -> null if someone else holds it
//   ...work...
//   renewLock(key, token, ttlMs)      -> keep it alive while working
//   releaseLock(key, token)           -> only releases if we still own it
//
// The check-and-act Lua scripts make renew/release safe in the case where our
// token already expired and someone else now holds the lock.

const crypto = require("crypto");
const { getRedis } = require("./client");

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

const acquireLock = async (key, ttlMs) => {
  const redis = getRedis();
  if (!redis) return null;
  const token = crypto.randomBytes(16).toString("hex");
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  return ok ? token : null;
};

const renewLock = async (key, token, ttlMs) => {
  const redis = getRedis();
  if (!redis || !token) return false;
  const result = await redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs);
  return Number(result) === 1;
};

const releaseLock = async (key, token) => {
  const redis = getRedis();
  if (!redis || !token) return false;
  const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
  return Number(result) === 1;
};

module.exports = { acquireLock, renewLock, releaseLock };
