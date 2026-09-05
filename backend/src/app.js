// Express application. Kept separate from server.js so tests can mount the app
// without starting timers, workers or a listener.

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const routes = require("./routes");
const { config } = require("./config/env");
const { isEnabled: redisEnabled } = require("./services/queue/client");
const { queueCounts } = require("./services/queue/emailQueue");

const createApp = () => {
  const app = express();

  app.disable("x-powered-by");

  // The frontend origin, plus same-origin/no-origin callers (the OAuth
  // redirect, curl, health probes).
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origin === config.frontendUrl),
      credentials: true,
    })
  );

  // Templates can be sizeable once images and HTML are inlined; lead files come
  // through multer, not here.
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  // Liveness + a real readiness picture: what is connected, and how deep the
  // queue is. Unauthenticated so a load balancer can call it.
  app.get("/health", async (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    const counts = await queueCounts();
    res.status(dbUp ? 200 : 503).json({
      ok: dbUp,
      roles: config.roles.all,
      mongo: dbUp ? "connected" : "disconnected",
      redis: redisEnabled() ? "configured" : "not configured",
      queue: counts,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.use("/api/v1", routes);

  app.use((req, res) => res.status(404).json({ message: `No route for ${req.method} ${req.path}` }));

  // Central error handler. Turns anything thrown in a route into a JSON
  // response instead of an HTML stack trace, and surfaces the two failure modes
  // that would otherwise read as opaque 500s.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "That already exists" });
    }
    if (err?.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: "That file is too large" });
    }
    console.error(`[api] ${req.method} ${req.path}:`, err);
    return res
      .status(500)
      .json({ message: config.isProd ? "Internal server error" : err.message });
  });

  return app;
};

module.exports = { createApp };
