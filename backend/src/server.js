// Process entrypoint.
//
// Which subsystems run is controlled by ROLES (default "api,scheduler,worker"),
// so the same image can be deployed as an all-in-one for development or split
// into separate API / scheduler / worker processes to scale sending
// independently of the API:
//
//   ROLES=api,scheduler,worker  npm start        (one process; the default)
//   ROLES=api                   npm run start:api
//   ROLES=scheduler             npm run start:scheduler
//   ROLES=worker                npm run start:worker
//
// Running several scheduler processes is safe -- the Redis leader lock elects
// one. Running several workers is not just safe but the point: they compete for
// jobs, and the unique-index claim means concurrency can never cause a
// duplicate send.

const { createApp } = require("./app");
const { config, validate } = require("./config/env");
const { connectDb, disconnectDb } = require("./config/db");
const { verifyCriticalIndexes } = require("../scripts/lib/indexes");
const { startScheduler, stopScheduler } = require("./services/campaigns/scheduler");
const { startEmailWorker, stopEmailWorker } = require("./workers/emailWorker");
const { startReaper, stopReaper } = require("./services/campaigns/reaper");
const { closeRedis } = require("./services/queue/client");

let server = null;
let shuttingDown = false;

const start = async () => {
  const { fatal, warn } = validate();

  if (fatal.length) {
    console.error("\nConfiguration errors -- refusing to start:\n");
    for (const f of fatal) console.error(`  x ${f}`);
    console.error("\nCopy .env.example to .env and fill it in.\n");
    process.exit(1);
  }
  for (const w of warn) console.warn(`  ! ${w}`);

  await connectDb();

  // Build indexes and VERIFY the two unique ones exist.
  //
  // This is not boilerplate. A unique index cannot be built over a collection
  // that already holds violating rows, and the usual autoIndex path swallows
  // that error -- so the duplicate-send guarantee can silently not exist, and
  // you find out when a lead is emailed twice. Refuse to send rather than send
  // wrongly.
  const indexReport = await verifyCriticalIndexes();
  if (!indexReport.ok) {
    console.error("\nCritical indexes are MISSING:\n");
    for (const m of indexReport.missing) console.error(`  x ${m}`);
    console.error(
      "\nThe duplicate-send guarantee is not in force. Run:\n" +
        "  npm run dedupe -- --apply     (removes existing duplicate rows)\n" +
        "  npm run ensure-indexes\n"
    );
    if (config.roles.scheduler || config.roles.worker) process.exit(1);
  }

  if (config.roles.api) {
    const app = createApp();
    server = app.listen(config.port, () => {
      console.log(`[api] listening on ${config.port}  (public: ${config.publicUrl})`);
    });
  }

  if (config.roles.scheduler) {
    startScheduler();
    startReaper();
  }

  if (config.roles.worker) {
    startEmailWorker();
  }

  console.log(`[boot] roles: ${config.roles.all.join(", ")}`);
};

// Graceful shutdown. The worker is closed FIRST and awaited, so an in-flight
// send finishes and marks its row rather than being killed mid-flight and left
// as an orphaned claim for the reaper to find.
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} -- draining...`);

  const timeout = setTimeout(() => {
    console.error("[shutdown] took too long, forcing exit");
    process.exit(1);
  }, 30_000);
  timeout.unref?.();

  try {
    await stopEmailWorker();
    await stopScheduler();
    stopReaper();
    if (server) await new Promise((r) => server.close(r));
    await closeRedis();
    await disconnectDb();
    console.log("[shutdown] clean");
    process.exit(0);
  } catch (e) {
    console.error("[shutdown] error:", e.message);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandled rejection:", err);
});

start().catch((err) => {
  console.error("[boot] failed:", err);
  process.exit(1);
});
