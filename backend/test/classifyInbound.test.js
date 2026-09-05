// Reply classification: the distinction that keeps the reply rate honest.
//
// Runs offline -- no database, no network, no API keys.

const test = require("node:test");
const assert = require("node:assert");

const { classifyInbound } = require("../src/services/replies/classifyInbound");

test("a plain human reply is a reply", () => {
  const r = classifyInbound({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Re: quick question",
    snippet: "Sure, happy to chat. How about Thursday?",
  });
  assert.strictEqual(r.type, "reply");
});

test("a MAILER-DAEMON user-unknown is a HARD bounce", () => {
  const r = classifyInbound({
    from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    subject: "Delivery Status Notification (Failure)",
    snippet: "Address not found. Your message wasn't delivered to nobody@acme.com because the address couldn't be found.",
  });
  assert.strictEqual(r.type, "bounced");
  assert.ok(r.reason.length > 0, "a hard bounce should carry a reason for the UI");
});

test("a full mailbox is a SOFT bounce, not a hard one", () => {
  const r = classifyInbound({
    from: "postmaster@acme.com",
    subject: "Undeliverable: your message",
    snippet: "The recipient's mailbox is full and cannot accept messages now.",
  });
  assert.strictEqual(r.type, "soft_bounce");
});

test("an ungradeable DSN falls to SOFT -- never brand an address wrong without proof", () => {
  const r = classifyInbound({
    from: "MAILER-DAEMON@relay.example.net",
    subject: "Returned mail",
    snippet: "Something went wrong somewhere in the pipeline.",
  });
  assert.strictEqual(r.type, "soft_bounce");
});

test("an out-of-office is an auto_reply, NOT a reply", () => {
  const r = classifyInbound({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Automatic reply: quick question",
    snippet: "I am out of the office until Monday with limited access to email.",
  });
  assert.strictEqual(r.type, "auto_reply");
});

test("Auto-Submitted header alone marks an auto_reply", () => {
  const r = classifyInbound({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Re: quick question",
    snippet: "Thanks for your note.",
    autoSubmitted: "auto-replied",
  });
  assert.strictEqual(r.type, "auto_reply");
});

test("X-Failed-Recipients marks a bounce even with an innocuous subject", () => {
  const r = classifyInbound({
    from: "someone@acme.com",
    subject: "Re: quick question",
    snippet: "no such user here",
    xFailedRecipients: "ghost@acme.com",
  });
  assert.ok(["bounced", "soft_bounce"].includes(r.type));
});

test("a delivery-status content type marks a bounce", () => {
  const r = classifyInbound({
    from: "relay@example.net",
    subject: "Message status",
    snippet: "see attached",
    contentType: 'multipart/report; report-type=delivery-status; boundary="x"',
  });
  assert.ok(["bounced", "soft_bounce"].includes(r.type));
});

test("a reply mentioning the word 'vacation' in passing is still a reply", () => {
  // Guards against over-eager auto-reply matching on body text: the auto-reply
  // signals are read from the SUBJECT and headers, not arbitrary prose.
  const r = classifyInbound({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Re: quick question",
    snippet: "Just back from vacation - yes, let's set something up next week.",
  });
  assert.strictEqual(r.type, "reply");
});
