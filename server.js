/**
 * Broken Link Crawler — Backend API
 * Railway deployment
 */

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { runCrawler } = require("./crawler");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory job store (Railway is ephemeral — fine for this use case)
const jobs = new Map();
// { id, status: 'queued'|'running'|'done'|'stopped'|'error', stopRequested: bool, progress: [], report: '', stats: {} }

// ── POST /api/crawl — start a new job ────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const config = req.body;

  // Basic validation
  if (!config.startUrl || !config.loginUrl) {
    return res.status(400).json({ error: "startUrl and loginUrl are required" });
  }

  const id = uuidv4();
  jobs.set(id, {
    id,
    status: "queued",
    stopRequested: false,
    progress: [],
    report: null,
    stats: null,
    startedAt: Date.now(),
  });

  // Run async — don't await
  runCrawler(config, (event) => {
    const job = jobs.get(id);
    if (!job) return;

    if (event.type === "progress") {
      job.progress.push(event.message);
      // Keep last 500 messages to avoid memory bloat
      if (job.progress.length > 500) job.progress = job.progress.slice(-500);
    } else if (event.type === "done") {
      job.status = job.stopRequested ? "stopped" : "done";
      job.report = event.report;
      job.stats = event.stats;
    } else if (event.type === "error") {
      job.status = "error";
      job.progress.push("ERROR: " + event.message);
    }
  }, () => jobs.get(id)?.stopRequested).then(() => {
    const job = jobs.get(id);
    if (job && job.status !== "done" && job.status !== "stopped") job.status = "error";
  }).catch((e) => {
    const job = jobs.get(id);
    if (job) {
      job.status = "error";
      job.progress.push("Fatal: " + e.message);
    }
  });

  const job = jobs.get(id);
  job.status = "running";

  res.json({ id });
});

// ── GET /api/crawl/:id/stream — SSE progress stream ──────────────────────────
app.get("/api/crawl/:id/stream", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastSent = 0;

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const j = jobs.get(req.params.id);
    if (!j) { clearInterval(interval); res.end(); return; }

    // Send any new progress lines
    const newLines = j.progress.slice(lastSent);
    if (newLines.length) {
      newLines.forEach((msg) => send({ type: "progress", message: msg }));
      lastSent = j.progress.length;
    }

    if (j.status === "done" || j.status === "stopped") {
      send({ type: "done", stats: j.stats });
      clearInterval(interval);
      res.end();
    } else if (j.status === "error") {
      send({ type: "error" });
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on("close", () => clearInterval(interval));
});

// ── GET /api/crawl/:id/report — fetch the HTML report ────────────────────────
app.get("/api/crawl/:id/report", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done" && job.status !== "stopped") return res.status(202).json({ error: "Not ready yet" });
  res.setHeader("Content-Type", "text/html");
  res.send(job.report);
});

// ── GET /api/crawl/:id/status ─────────────────────────────────────────────────
app.get("/api/crawl/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ id: job.id, status: job.status, stats: job.stats });
});

// ── POST /api/crawl/:id/stop — request graceful stop ─────────────────────────
app.post("/api/crawl/:id/stop", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "running") return res.json({ ok: true, note: "Job not running" });
  job.stopRequested = true;
  res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀  API listening on :${PORT}`));
