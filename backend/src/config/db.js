// MongoDB connection. This project owns its own database — it must never be
// pointed at another application's data.

const dns = require("dns");
const mongoose = require("mongoose");
const { config } = require("./env");

// Repair Node's DNS resolver when it has no usable nameserver.
//
// A mongodb+srv:// URI is resolved by the driver through dns.resolveSrv() and
// dns.resolveTxt(). Those go to c-ares, Node's own in-process resolver -- NOT
// to the OS resolver that dns.lookup(), nslookup and every other program use.
// When c-ares cannot build a server list from the host's network config it
// falls back to a hardcoded 127.0.0.1, and unless something is actually
// serving DNS on loopback every SRV lookup dies with ECONNREFUSED before a
// single socket is opened -- which reads like an Atlas/auth/firewall problem
// and is none of those. (Seen on Windows when an adapter advertises a
// malformed IPv6 nameserver, e.g. a link-local fe80:: address with no scope
// id: the whole list, valid IPv4 entries included, is discarded.)
//
// This is a no-op on any correctly configured host: it fires only when the
// resolver has nothing but loopback to work with.
const DNS_FALLBACK = ["1.1.1.1", "8.8.8.8"];

const isUnusable = (servers) =>
  servers.length === 0 ||
  servers.every((s) => /^(127\.|::1$|\[::1\])/.test(s));

const ensureResolvableSrv = () => {
  if (!config.mongoUri.startsWith("mongodb+srv://")) return;

  const current = dns.getServers();
  if (config.dnsServers.length) {
    dns.setServers(config.dnsServers);
    console.log(`[dns] using DNS_SERVERS: ${config.dnsServers.join(", ")}`);
    return;
  }
  if (!isUnusable(current)) return;

  dns.setServers(DNS_FALLBACK);
  console.warn(
    `[dns] this host gave Node no usable nameserver (got ${current.join(", ") || "none"}), ` +
    `so mongodb+srv:// lookups would fail with ECONNREFUSED. Falling back to ` +
    `${DNS_FALLBACK.join(", ")} for SRV resolution only. Set DNS_SERVERS to choose your own, ` +
    `or fix the host's DNS configuration to remove this warning.`
  );
};

const connectDb = async () => {
  ensureResolvableSrv();

  mongoose.set("strictQuery", true);

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });

  const { name } = mongoose.connection;
  console.log(`[db] connected to "${name}"`);
  return mongoose.connection;
};

const disconnectDb = () => mongoose.connection.close();

module.exports = { connectDb, disconnectDb };
