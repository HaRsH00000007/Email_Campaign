// Shared Redis client (ioredis). Singleton -- call getRedis().
//
// REDIS_URL controls the connection:
//   redis://default:<password>@<host>:<port>
//   rediss://...                             (TLS; most managed providers)
//
// Redis is REQUIRED for delivery in this project. Without it there is no queue,
// no leader lock and no mailbox rate limiting, and the sender deliberately
// refuses to hand out work rather than lose leads. The API still boots and
// serves reads so the UI can explain what is wrong.

const Redis = require("ioredis");
const { config } = require("../../config/env");

let client = null;

const isEnabled = () => !!config.redisUrl;

const OPTIONS = {
  // BullMQ requires both. They are also the right defaults for a long-lived
  // shared client: do not fail commands while reconnecting.
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const getRedis = () => {
  if (!isEnabled()) return null;
  if (client) return client;

  client = new Redis(config.redisUrl, OPTIONS);
  client.on("connect", () => console.log("[redis] connected"));
  client.on("ready", () => console.log("[redis] ready"));
  client.on("error", (err) => console.error("[redis] error:", err.message));
  client.on("close", () => console.warn("[redis] connection closed"));
  return client;
};

// BullMQ wants its own connection for blocking commands, so queue and worker
// modules take a fresh one while everything else shares the singleton.
const createConnection = () => (isEnabled() ? new Redis(config.redisUrl, OPTIONS) : null);

const closeRedis = async () => {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
};

module.exports = { getRedis, createConnection, isEnabled, closeRedis };
