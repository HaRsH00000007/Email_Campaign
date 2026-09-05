// Remove duplicate message rows so the unique indexes can build.
//
//   node scripts/dedupeEmailMessages.js           DRY RUN -- reports only
//   node scripts/dedupeEmailMessages.js --apply   actually delete, then build
//
// A fresh install never needs this. It exists for a database that predates the
// indexes, or one where they failed to build and duplicates accumulated.
//
// Which row survives is not arbitrary: the one reflecting the lead's true best
// outcome wins (replied > bounced > delivered > failed > queued), so a dedupe
// can never discard the fact that someone replied.

require("dotenv").config();
const { connectDb, disconnectDb } = require("../src/config/db");
const EmailMessage = require("../src/models/emailMessage");
const { findDuplicates, chooseKeeper, buildAllIndexes, verifyCriticalIndexes } = require("./lib/indexes");

const APPLY = process.argv.includes("--apply");

const main = async () => {
  await connectDb();

  const { dupPitches, dupFollowups } = await findDuplicates();

  if (!dupPitches.length && !dupFollowups.length) {
    console.log("\nNo duplicates found. Nothing to do.\n");
    const report = await verifyCriticalIndexes();
    console.log(
      report.ok
        ? "Unique indexes are present -- duplicate protection is in force.\n"
        : `Unique indexes still MISSING: ${report.missing.join(", ")}\n`
    );
    await disconnectDb();
    return;
  }

  const toDelete = [];

  console.log(`\nDuplicate PITCH groups: ${dupPitches.length}`);
  for (const g of dupPitches) {
    const { keep, drop } = chooseKeeper(g.ids, g.statuses);
    toDelete.push(...drop);
    console.log(
      `  ${g._id.leadEmail} in campaign ${g._id.campaignId}: ${g.n} rows [${g.statuses.join(", ")}] -> keep ${keep}`
    );
  }

  console.log(`\nDuplicate FOLLOW-UP groups: ${dupFollowups.length}`);
  for (const g of dupFollowups) {
    const { keep, drop } = chooseKeeper(g.ids, g.statuses);
    toDelete.push(...drop);
    console.log(
      `  ${g._id.leadEmail} step ${g._id.followupStep}: ${g.n} rows [${g.statuses.join(", ")}] -> keep ${keep}`
    );
  }

  console.log(`\nTotal rows to delete: ${toDelete.length}`);

  if (!APPLY) {
    console.log("\nDRY RUN -- nothing was deleted. Re-run with --apply to act.\n");
    await disconnectDb();
    return;
  }

  const { deletedCount } = await EmailMessage.deleteMany({ _id: { $in: toDelete } });
  console.log(`\nDeleted ${deletedCount} row(s). Building indexes...`);

  const { failed } = await buildAllIndexes();
  if (failed.length) {
    for (const f of failed) console.error(`  x ${f.model}: ${f.error}`);
  }

  const report = await verifyCriticalIndexes();
  console.log(
    report.ok
      ? "\nDuplicate protection is now IN FORCE.\n"
      : `\nStill missing: ${report.missing.join(", ")}\n`
  );

  await disconnectDb();
};

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
