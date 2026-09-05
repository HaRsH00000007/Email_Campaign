// Send quota hook -- the extension point where billing would live.
//
// ADAPTED, and this is a deliberate decoupling. The reference implementation
// charged credits per email: the runner reserved a credit atomically when it
// claimed a lead, and refunded it if the send ultimately failed. That coupled
// the send path to a Stripe-backed credit ledger, a User.credits field, a
// packages catalog and a transaction log -- none of which a standalone email
// tool needs.
//
// What IS worth keeping is the SHAPE. The claim path has three ordered steps
// (claim -> reserve -> enqueue), and each one must roll back the ones before it
// when it fails. Deleting the middle step would have quietly removed those
// rollback paths and left the code subtly wrong for whoever adds metering
// later. So the step remains, with a no-op default.
//
// To meter sending, implement reserve() and refund() here. Contract:
//
//   reserve(userId, ctx) -> Promise<boolean>
//       true  = allowed; the caller proceeds to enqueue
//       false = denied;  the caller ROLLS BACK the claim and leaves the lead
//               cursor where it is, so the lead retries later rather than being
//               consumed. Must be atomic under concurrency (e.g. a conditional
//               $inc guarded by $gte) or two workers can both overdraft.
//
//   refund(userId, ctx) -> Promise<void>
//       Called exactly once when a reserved send ultimately fails permanently.
//       Must be safe to call when nothing was reserved.

const ENABLED = String(process.env.SEND_QUOTA_ENABLED || "").toLowerCase() === "true";

// Default: unmetered. Every send is allowed.
const reserve = async (_userId, _ctx = {}) => {
  if (!ENABLED) return true;
  // Implement metering here. Returning false must be safe: the caller rolls the
  // claim back and retries the lead on a later tick.
  return true;
};

const refund = async (_userId, _ctx = {}) => {
  if (!ENABLED) return;
  // Implement the compensating action here.
};

const isEnabled = () => ENABLED;

module.exports = { reserve, refund, isEnabled };
