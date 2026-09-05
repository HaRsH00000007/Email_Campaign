// Single source of truth for what each EmailMessage status MEANS, so the
// reply-rate math is identical everywhere (campaign rollup, metrics, exports,
// repair scripts). Change a bucket here, not in five aggregations.
//
// A pitch reached a real mailbox ("delivered") if it was accepted and either
// sat silent, got a human reply, or triggered an auto-responder -- an existing
// mailbox is exactly what an auto-reply proves. It did NOT reach the lead if it
// hard- or soft-bounced, failed at send time, or is still queued.

// Delivered = the reply-rate DENOMINATOR.
const DELIVERED_STATES = ["sent", "replied", "auto_reply"];

// A genuine human reply = the reply-rate NUMERATOR.
const REPLY_STATES = ["replied"];

// Hard bounce -- wrong / invalid address.
const HARD_BOUNCE_STATES = ["bounced"];

// The "other" bucket: soft bounce + autoresponder.
const OTHER_STATES = ["soft_bounced", "auto_reply"];

// Anything that did NOT get through to the lead.
const UNDELIVERED_STATES = ["bounced", "soft_bounced", "failed"];

// Statuses that are still worth polling for an outcome. "auto_reply" is
// included on purpose: an out-of-office is not terminal, because a real reply
// can still arrive after it.
const PENDING_STATES = ["sent", "auto_reply"];

// Terminal -- no further polling can change these.
const TERMINAL_STATES = ["replied", "bounced", "soft_bounced", "failed"];

// Full enum for the schema (order = queued -> outcome).
const ALL_STATES = [
  "queued",
  "sent",
  "failed",
  "replied",
  "bounced",
  "soft_bounced",
  "auto_reply",
];

// Map a classifyInbound() result type onto the stored status.
const TYPE_TO_STATUS = {
  reply: "replied",
  bounced: "bounced",
  soft_bounce: "soft_bounced",
  auto_reply: "auto_reply",
};

// Human labels, shared by the UI and the CSV export so both read the same.
const STATUS_LABEL = {
  queued: "Queued",
  sent: "Delivered",
  replied: "Replied",
  bounced: "Wrong address",
  soft_bounced: "Bounced",
  auto_reply: "Auto-reply",
  failed: "Failed",
};

const isDelivered = (s) => DELIVERED_STATES.includes(s);
const isTerminal = (s) => TERMINAL_STATES.includes(s);

module.exports = {
  DELIVERED_STATES,
  REPLY_STATES,
  HARD_BOUNCE_STATES,
  OTHER_STATES,
  UNDELIVERED_STATES,
  PENDING_STATES,
  TERMINAL_STATES,
  ALL_STATES,
  TYPE_TO_STATUS,
  STATUS_LABEL,
  isDelivered,
  isTerminal,
};
