// Create the first user without going through the API.
//
//   node scripts/createUser.js you@example.com "Your Name"
//
// Prompts for a password on stdin (never passed as an argument, where it would
// land in shell history and the process list).

require("dotenv").config();
const readline = require("readline");
const { connectDb, disconnectDb } = require("../src/config/db");
const { User } = require("../src/models");
const { hashPassword } = require("../src/utils/password");

const askHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (["\n", "\r", ""].includes(String(char))) {
        process.stdin.removeListener("data", onData);
      } else {
        // Redraw the prompt without echoing what was typed.
        process.stdout.write(`\r\x1b[2K${question}`);
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });

const main = async () => {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const name = String(process.argv[3] || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Usage: node scripts/createUser.js <email> [name]");
    process.exit(1);
  }

  await connectDb();

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    console.error(`\n${email} already exists.\n`);
    await disconnectDb();
    process.exit(1);
  }

  const password = await askHidden("Password (min 10 chars): ");
  if (password.length < 10) {
    console.error("\nPassword must be at least 10 characters.\n");
    await disconnectDb();
    process.exit(1);
  }

  await User.create({
    email,
    name,
    passwordHash: await hashPassword(password),
    signature: name,
  });

  console.log(`\nCreated ${email}. Log in at the frontend to connect a mailbox.\n`);
  await disconnectDb();
};

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
