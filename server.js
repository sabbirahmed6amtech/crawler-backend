/**
 * Broken Link Crawler — Backend API
 * Railway deployment
 * Uses polling instead of SSE to avoid Railway HTTP/2 connection drops
 */

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { runCrawler } = require("./crawler");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory job store
// { id, status: 'queued'|'running'|'done'|'stopped'|'error', stopRequested, progress[], report, stats }
const jobs = new Map();

// ── POST /api/crawl — start a new job ────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const config = req.body;
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

  runCrawler(config, (event) => {
    const job = jobs.get(id);
    if (!job) return;
    if (event.type === "progress") {
      job.progress.push(event.message);
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

  jobs.get(id).status = "running";
  res.json({ id });
});

// ── GET /api/crawl/:id/poll — polling endpoint ────────────────────────────────
// Frontend calls this every 1.5s with ?since=N to get new log lines from index N
// Replaces SSE — avoids Railway HTTP/2 long-connection drops
app.get("/api/crawl/:id/poll", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const since = parseInt(req.query.since) || 0;
  const newLines = job.progress.slice(since);

  res.json({
    lines: newLines,
    cursor: job.progress.length,
    status: job.status,
    stats: job.stats || null,
  });
});

// ── GET /api/crawl/:id/report — fetch the HTML report ────────────────────────
app.get("/api/crawl/:id/report", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done" && job.status !== "stopped") {
    return res.status(202).json({ error: "Not ready yet", status: job.status });
  }
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
