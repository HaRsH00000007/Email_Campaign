// Build every declared index and REPORT failures.
//
//   node scripts/ensureIndexes.js
//
// Run this after any deploy, and always before trusting the duplicate-send
// guarantee. If a unique index fails to build, run scripts/dedupeEmailMessages.js
// first to clear the violating rows.

require("dotenv").config();
const { connectDb, disconnectDb } = require("../src/config/db");
const { buildAllIndexes, verifyCriticalIndexes } = require("./lib/indexes");

const main = async () => {
  await connectDb();

  console.log("\nBuilding indexes...\n");
  const { built, failed } = await buildAllIndexes();
  console.log(`  built indexes for ${built} model(s)`);

  if (failed.length) {
    console.error("\n  FAILURES:");
    for (const f of failed) console.error(`    x ${f.model}: ${f.error}`);
  }

  console.log("\nVerifying the duplicate-send guarantee...\n");
  const report = await verifyCriticalIndexes();

  if (report.ok) {
    console.log("  ok  uniq_pitch_per_lead");
    console.log("  ok  uniq_followup_step_per_lead");
    console.log("\nDuplicate protection is IN FORCE.\n");
  } else {
    console.error("  MISSING:");
    for (const m of report.missing) console.error(`    x ${m}`);
    console.error(
      "\nDuplicate protection is NOT in force.\n" +
        "A unique index cannot build over a collection that already holds duplicates.\n" +
        "Fix with:\n" +
        "  node scripts/dedupeEmailMessages.js            (dry run -- shows what it would delete)\n" +
        "  node scripts/dedupeEmailMessages.js --apply\n"
    );
  }

  await disconnectDb();
  process.exit(report.ok && !failed.length ? 0 : 1);
};

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
