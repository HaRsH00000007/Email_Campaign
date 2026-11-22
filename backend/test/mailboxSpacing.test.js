// INTEGRATION TEST: the per-mailbox 60s spacing guarantee.
//
// This property is enforced by a Lua script running inside Redis, which is the
// only place it CAN be enforced -- the whole point is that it holds across
// processes. So it is tested against a real Redis rather than a mock: a mock
// would be testing a reimplementation of the thing most likely to be wrong.
//
// Needs REDIS_URL (or a local Redis on the project's default port). Without
// one the file SKIPS rather than failing, so the unit suite stays runnable on a
// machine with no services up.

const test = require("node:test");
const assert = require("node:assert");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "t".repeat(48);

// Configure BEFORE requiring the limiter -- it reads these at module load.
process.env.MAILBOX_MIN_SPACING_MS = "60000";
delete process.env.MAILBOX_HOURLY_LIMIT;

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
process.env.REDIS_URL = REDIS_URL;

const Redis = require("ioredis");

const reachable = async () => {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return probe;
  } catch {
    probe.disconnect();
    return null;
  }
};

test("per-mailbox send spacing (integration, real Redis)", async (t) => {
  // The probe has to happen INSIDE the test: this file is CommonJS, so there is
  // no top-level await to decide skip-or-run with before the suite is declared.
  const probe = await reachable();
  if (!probe) {
    t.skip(`no Redis at ${REDIS_URL} -- skipping the spacing integration suite`);
    return;
  }
  probe.disconnect();

  const limiter = require("../src/services/rateLimit/mailboxLimiter");
  const { getRedis } = require("../src/services/queue/client");
  const redis = getRedis();

  // Every test gets its own mailbox id, so nothing leaks between cases and the
  // suite never collides with real campaign data in a shared dev Redis.
  let n = 0;
  const freshId = () => `test-mbox-${process.pid}-${Date.now()}-${n++}`;
  const used = [];
  const mbox = () => {
    const id = freshId();
    used.push(id);
    return id;
  };

  // Retry until the limiter lets a send through, or give up. Returns the last
  // result either way, so a timeout fails with the real denial reason rather
  // than a bare "timed out".
  const waitUntilAllowed = async (id, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      last = await limiter.tryConsume(id, { minSpacingMs: 0 });
      if (last.ok || Date.now() >= deadline) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  t.after(async () => {
    const keys = used.flatMap((id) => [
      limiter._keys.dayKey(id, Date.now()),
      limiter._keys.hourKey(id, Date.now()),
      limiter._keys.lastKey(id),
      limiter._keys.coolKey(id),
    ]);
    if (keys.length) await redis.del(...keys).catch(() => {});
    await redis.quit().catch(() => {});
  });

  // ---------------------------------------------------------------------
  await t.test("a second send inside the spacing window is denied", async () => {
    const id = mbox();

    const first = await limiter.tryConsume(id);
    assert.strictEqual(first.ok, true, "the first send must go through");

    const second = await limiter.tryConsume(id);
    assert.strictEqual(second.ok, false, "a send 0ms later must be denied");
    assert.strictEqual(second.reason, "mailbox_spacing");
    assert.ok(
      second.retryAfterMs > 55_000 && second.retryAfterMs <= 60_000,
      `retryAfterMs should be ~the remaining window, got ${second.retryAfterMs}`
    );
  });

  // ---------------------------------------------------------------------
  await t.test("the send is allowed once the window has elapsed", async () => {
    const id = mbox();
    // 2s spacing keeps the test fast while exercising the identical code path.
    assert.strictEqual((await limiter.tryConsume(id, { minSpacingMs: 2000 })).ok, true);
    assert.strictEqual((await limiter.tryConsume(id, { minSpacingMs: 2000 })).ok, false);

    await new Promise((r) => setTimeout(r, 2100));

    const after = await limiter.tryConsume(id, { minSpacingMs: 2000 });
    assert.strictEqual(after.ok, true, "the window elapsed, so this must pass");
  });

  // ---------------------------------------------------------------------
  await t.test("CONCURRENT workers cannot collectively beat the spacing", async () => {
    // The whole reason the check lives in a Lua script. Fire 25 consume
    // attempts with no awaiting between them, exactly as N workers on N
    // machines would. A read-then-write in JS lets several through here.
    const id = mbox();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.tryConsume(id))
    );
    const allowed = results.filter((r) => r.ok).length;

    assert.strictEqual(allowed, 1, `exactly one of 25 concurrent sends may pass, got ${allowed}`);
    for (const r of results.filter((x) => !x.ok)) {
      assert.strictEqual(r.reason, "mailbox_spacing");
    }
  });

  // ---------------------------------------------------------------------
  await t.test("a denial does not push the next allowed send further out", async () => {
    // Counters and the spacing stamp must advance only on SUCCESS. If a denial
    // moved the stamp, a busy queue would starve the mailbox forever.
    const id = mbox();
    await limiter.tryConsume(id, { minSpacingMs: 2000 });

    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await limiter.tryConsume(id, { minSpacingMs: 2000 });

    await new Promise((r) => setTimeout(r, Math.max(0, 2100 - (Date.now() - t0))));
    assert.strictEqual(
      (await limiter.tryConsume(id, { minSpacingMs: 2000 })).ok,
      true,
      "ten denials must not have delayed the next slot"
    );
  });

  // ---------------------------------------------------------------------
  await t.test("ONE mailbox being paced does not delay a DIFFERENT mailbox", async () => {
    const a = mbox();
    const b = mbox();

    assert.strictEqual((await limiter.tryConsume(a)).ok, true);
    assert.strictEqual((await limiter.tryConsume(a)).ok, false, "a is now spaced out");

    assert.strictEqual(
      (await limiter.tryConsume(b)).ok,
      true,
      "b has its own clock and must be unaffected"
    );
  });

  // ---------------------------------------------------------------------
  await t.test("there is NO daily cap: sending continues past any old quota", async () => {
    // The headline behaviour change. Drive the day counter far past the former
    // MAILBOX_DAILY_LIMIT of 2000 and assert every send is still permitted.
    const id = mbox();
    const dayK = limiter._keys.dayKey(id, Date.now());
    await redis.set(dayK, "500000");

    for (let i = 0; i < 5; i++) {
      const r = await limiter.tryConsume(id, { minSpacingMs: 0 });
      assert.strictEqual(r.ok, true, `send ${i} must pass despite a huge day count`);
    }

    const after = Number(await redis.get(dayK));
    assert.strictEqual(after, 500_005, "the day counter still COUNTS, it just never denies");
  });

  // ---------------------------------------------------------------------
  await t.test("the optional hourly ceiling still works when set", async () => {
    const id = mbox();
    assert.strictEqual((await limiter.tryConsume(id, { minSpacingMs: 0, hourlyLimit: 2 })).ok, true);
    assert.strictEqual((await limiter.tryConsume(id, { minSpacingMs: 0, hourlyLimit: 2 })).ok, true);

    const third = await limiter.tryConsume(id, { minSpacingMs: 0, hourlyLimit: 2 });
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, "mailbox_hourly_limit");
  });

  // ---------------------------------------------------------------------
  await t.test("a provider cooldown blocks the whole mailbox and then expires", async () => {
    const id = mbox();

    await limiter.cooldown(id, 1000, "gmail_429");
    const denied = await limiter.tryConsume(id, { minSpacingMs: 0 });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, "provider_cooldown");
    assert.ok(denied.retryAfterMs <= 1000 && denied.retryAfterMs > 0);

    // Poll rather than sleeping for a fixed margin. A single sleep just over
    // the TTL makes the test a race against scheduler jitter on a loaded
    // machine; polling asserts the same property without the flake.
    const resumed = await waitUntilAllowed(id, 5000);
    assert.strictEqual(
      resumed.ok,
      true,
      "sending must resume on its own once the restriction expires"
    );
  });

  // ---------------------------------------------------------------------
  await t.test("a cooldown outranks the hourly ceiling and the spacing", async () => {
    // Ordering matters: the provider's restriction is the one real signal, so
    // it must be reported even when another rule would also have denied.
    const id = mbox();
    await limiter.tryConsume(id); // sets the spacing stamp
    await limiter.cooldown(id, 3000, "gmail_quota");

    const r = await limiter.tryConsume(id);
    assert.strictEqual(r.reason, "provider_cooldown", "the provider reason must win");
  });

  // ---------------------------------------------------------------------
  await t.test("a shorter cooldown cannot shorten a longer one already set", async () => {
    const id = mbox();
    await limiter.cooldown(id, 60_000, "gmail_quota");
    await limiter.cooldown(id, 1000, "gmail_429");

    const r = await limiter.tryConsume(id, { minSpacingMs: 0 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.retryAfterMs > 30_000, `the long cooldown must stand, got ${r.retryAfterMs}ms`);
  });

  // ---------------------------------------------------------------------
  await t.test("release hands back a counted slot without rewinding the spacing", async () => {
    const id = mbox();
    await limiter.tryConsume(id);

    const dayK = limiter._keys.dayKey(id, Date.now());
    assert.strictEqual(Number(await redis.get(dayK)), 1);

    await limiter.release(id);
    assert.strictEqual(Number(await redis.get(dayK)), 0, "the counter is returned");

    const r = await limiter.tryConsume(id);
    assert.strictEqual(r.ok, false, "but the mailbox is still spaced out -- release must not");
    assert.strictEqual(r.reason, "mailbox_spacing", "   let a queued job fire immediately");
  });

  // ---------------------------------------------------------------------
  await t.test("release never creates a negative counter", async () => {
    // A bare DECR on a missing key creates it at -1 with no TTL, which reads as
    // "miles under the limit" forever.
    const id = mbox();
    await limiter.release(id);
    await limiter.release(id);

    const v = await redis.get(limiter._keys.dayKey(id, Date.now()));
    assert.ok(v === null || Number(v) >= 0, `counter must never go negative, got ${v}`);
  });
});
