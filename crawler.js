/**
 * Crawler module
 * Improvements:
 * - Retry failed links up to 2 times before marking broken
 * - Always emits a report even on crash/stop (via finally block)
 * - Report: click URL to copy, open button to redirect with full URL
 */

let puppeteer, got;
try { puppeteer = require("puppeteer"); } catch { throw new Error("puppeteer not installed"); }
try {
  got = require("got");
  if (got.default) got = got.default;
} catch { throw new Error("got not installed"); }

const RETRY_LIMIT = 2;
const RETRY_DELAY_MS = 1500;

const DEFAULT_CONFIG = {
  maxPages: 100,
  actionDelay: 800,
  pageTimeout: 20000,
  checkTimeout: 8000,
  checkConcurrency: 10,
  headless: true,
  noCrawlPatterns: [
    /\/lang\//,
    /\/item\/edit\//,
    /export.*type=/i,
    /\.(xlsx|xls|csv|pdf|zip)$/i,
    /bulk[_-]?(import|export|format)/i,
    /items_bulk/i,
    /\/cdn-cgi\//,
  ],
  ignorePatterns: [
    /^mailto:/,
    /^tel:/,
    /^javascript:/,
    /\/cdn-cgi\//,
    /\.(png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|css)$/i,
  ],
};

function normalise(url) {
  try { const u = new URL(url); u.hash = ""; return u.href; }
  catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runCrawler(userConfig, emit) {
  const CONFIG = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    noCrawlPatterns: DEFAULT_CONFIG.noCrawlPatterns,
    ignorePatterns: DEFAULT_CONFIG.ignorePatterns,
  };

  const origin = new URL(CONFIG.startUrl).origin;
  const visited = new Set();
  const linkResults = new Map();
  const queue = [];
  let pageCount = 0;
  let sessionCookies = "";

  const shouldIgnore = (url) => CONFIG.ignorePatterns.some((p) => p.test(url));
  const shouldNotCrawl = (url) => CONFIG.noCrawlPatterns.some((p) => p.test(url));
  const log = (msg) => emit({ type: "progress", message: msg });

  // ── Always emit report regardless of how crawl ends ───────────────────────
  function emitReport(label) {
    const all = [...linkResults.values()];
    const broken = all.filter((r) => r.broken);
    const ok = all.filter((r) => !r.broken);
    log(`\n${label}  Pages: ${pageCount}  |  Links: ${all.length}  |  Broken: ${broken.length}`);
    const stats = { pages: pageCount, total: all.length, broken: broken.length, ok: ok.length };
    const report = buildReport({ all, broken, ok, pageCount, origin, startUrl: CONFIG.startUrl });
    emit({ type: "done", report, stats });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  async function login(browser) {
    log("🔐  Logging in…");
    const page = await browser.newPage();
    try {
      await page.goto(CONFIG.loginUrl, { waitUntil: "networkidle2", timeout: CONFIG.pageTimeout });

      const usernameSelector = CONFIG.usernameSelector || "input[name=email], input[type=email]";
      const passwordSelector = CONFIG.passwordSelector || "input[name=password], input[type=password]";
      const submitSelector = CONFIG.submitSelector || "button[type=submit], input[type=submit]";
      const postLoginSelector = CONFIG.postLoginSelector || "nav, .sidebar, .navbar, main, #app";

      await page.waitForSelector(usernameSelector, { timeout: 8000 });
      await page.type(usernameSelector, CONFIG.username, { delay: 40 });
      await page.type(passwordSelector, CONFIG.password, { delay: 40 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: CONFIG.pageTimeout }).catch(() => {}),
        page.click(submitSelector),
      ]);
      await page.waitForSelector(postLoginSelector, { timeout: CONFIG.pageTimeout }).catch(() => {});
      log(`✅  Logged in → ${page.url()}`);
      const cookies = await page.cookies();
      sessionCookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } finally {
      await page.close();
    }
  }

  // ── Single attempt ────────────────────────────────────────────────────────
  async function checkLinkOnce(url) {
    const res = await got.head(url, {
      timeout: { request: CONFIG.checkTimeout },
      followRedirect: true,
      throwHttpErrors: false,
      headers: { Cookie: sessionCookies, "User-Agent": "Mozilla/5.0 (compatible; LinkChecker/2.0)" },
    });
    let status = res.statusCode;
    if (status === 405) {
      const res2 = await got.get(url, {
        timeout: { request: CONFIG.checkTimeout },
        followRedirect: true,
        throwHttpErrors: false,
        headers: { Cookie: sessionCookies, "User-Agent": "Mozilla/5.0" },
      });
      status = res2.statusCode;
    }
    return status;
  }

  // ── Check link with retry ─────────────────────────────────────────────────
  async function checkLinkFast(url, foundOn) {
    if (linkResults.has(url)) return;
    const start = Date.now();
    let lastError = null;

    for (let attempt = 1; attempt <= RETRY_LIMIT + 1; attempt++) {
      try {
        const status = await checkLinkOnce(url);
        const broken = status >= 400;
        linkResults.set(url, { url, status, broken, foundOn, ms: Date.now() - start });
        if (broken) {
          log(`❌  ${status}  ${url.replace(origin, "")}  (on: ${foundOn.replace(origin, "")})`);
        }
        return;
      } catch (e) {
        lastError = e;
        if (attempt <= RETRY_LIMIT) {
          log(`⟳   Retry ${attempt}/${RETRY_LIMIT}  ${url.replace(origin, "")}`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    const status = lastError?.code === "ETIMEDOUT" || lastError?.code === "ETIMEOUT" ? "TIMEOUT" : "ERR";
    linkResults.set(url, { url, status, broken: true, foundOn, ms: Date.now() - start });
    log(`❌  ${status} (after ${RETRY_LIMIT} retries)  ${url.replace(origin, "")}`);
  }

  async function checkLinksBatch(links, foundOn) {
    const unchecked = links.filter((l) => !linkResults.has(l) && !shouldIgnore(l));
    for (let i = 0; i < unchecked.length; i += CONFIG.checkConcurrency) {
      await Promise.all(
        unchecked.slice(i, i + CONFIG.checkConcurrency).map((url) => checkLinkFast(url, foundOn))
      );
    }
  }

  // ── Crawl a single page ───────────────────────────────────────────────────
  async function crawlPage(browser, url) {
    if (visited.has(url)) return [];
    visited.add(url);
    pageCount++;
    log(`📄  [${pageCount}/${CONFIG.maxPages}] ${url.replace(origin, "")}`);

    const page = await browser.newPage();
    try {
      const res = await page.goto(url, { waitUntil: "networkidle2", timeout: CONFIG.pageTimeout });
      const status = res ? res.status() : 0;

      if (status >= 400) {
        log(`❌  ${status}  ${url.replace(origin, "")}  (page itself)`);
        linkResults.set(url, { url, status, broken: true, foundOn: "crawl-queue", ms: 0 });
        return [];
      }

      await sleep(CONFIG.actionDelay);

      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")].map((a) => a.href)
      );

      const links = [];
      for (const href of hrefs) {
        const u = normalise(href);
        if (!u || shouldIgnore(u)) continue;
        try { if (new URL(u).origin !== origin) continue; } catch { continue; }
        links.push(u);
      }
      return [...new Set(links)];
    } catch (e) {
      log(`⚠️   Skipped (error): ${url.replace(origin, "")}`);
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    if (CONFIG.username && CONFIG.password) {
      await login(browser);
    }

    queue.push(CONFIG.startUrl);
    log(`\n🕷️  Crawling ${CONFIG.startUrl}  (max ${CONFIG.maxPages} pages)\n`);

    while (queue.length && pageCount < CONFIG.maxPages) {
      const url = queue.shift();
      if (visited.has(url)) continue;

      const links = await crawlPage(browser, url);
      await checkLinksBatch(links, url);

      for (const link of links) {
        if (!visited.has(link) && !shouldNotCrawl(link)) {
          try { if (new URL(link).origin === origin) queue.push(link); } catch {}
        }
      }
    }

    emitReport("✅  Done!");
  } catch (e) {
    log(`\n⚠️  Crawler error: ${e.message} — saving partial report…`);
    emitReport("⚠️  Partial.");
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── HTML Report ───────────────────────────────────────────────────────────────
function buildReport({ all, broken, ok, pageCount, origin, startUrl }) {
  const byPage = {};
  for (const r of broken) {
    const key = (r.foundOn || "unknown").replace(origin, "");
    if (!byPage[key]) byPage[key] = [];
    byPage[key].push(r);
  }

  const sc = (s) =>
    s === 500 ? "#c0392b" : s === 404 ? "#e67e22" : s === 403 ? "#8e44ad" : "#7f8c8d";

  const urlCell = (r) => `
    <td class="url-cell">
      <span class="mono url-text" title="Click to copy" onclick="copyUrl('${r.url}',this)">${r.url.replace(origin, "")}</span>
      <a class="open-btn" href="${r.url}" target="_blank" rel="noopener" title="Open URL">↗</a>
    </td>`;

  const tableRows = broken.map((r) => `
    <tr data-status="${r.status}">
      <td><span class="badge" style="background:${sc(r.status)}">${r.status}</span></td>
      ${urlCell(r)}
      <td class="mono muted">${(r.foundOn || "").replace(origin, "")}</td>
      <td class="muted">${r.ms}ms</td>
    </tr>`).join("");

  const groupedHtml = Object.entries(byPage)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([page, items]) => `
    <div class="group">
      <div class="group-header">
        <span class="mono">${page}</span>
        <span class="badge-sm">${items.length} broken</span>
      </div>
      <div class="group-body">
        ${items.map((r) => `
          <div class="group-row">
            <span class="badge" style="background:${sc(r.status)}">${r.status}</span>
            <span class="mono url-text" title="Click to copy" onclick="copyUrl('${r.url}',this)">${r.url.replace(origin, "")}</span>
            <a class="open-btn" href="${r.url}" target="_blank" rel="noopener" title="Open URL">↗</a>
            <span class="muted">${r.ms}ms</span>
          </div>`).join("")}
      </div>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Broken Link Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#f0f2f5;color:#1a1a2e}
.topbar{background:#1a1a2e;color:#fff;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
.topbar h1{font-size:18px;font-weight:600}
.topbar p{font-size:12px;color:#8892b0;margin-top:2px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px 32px;background:#fff;border-bottom:1px solid #e2e8f0}
.stat{background:#f8fafc;border-radius:8px;padding:14px 18px;border:1px solid #e2e8f0}
.stat .n{font-size:28px;font-weight:700;line-height:1}
.stat .l{font-size:11px;color:#64748b;margin-top:3px;text-transform:uppercase;letter-spacing:.04em}
.stat.red .n{color:#dc2626}.stat.green .n{color:#16a34a}
.tabs{display:flex;background:#fff;border-bottom:1px solid #e2e8f0;padding:0 32px}
.tab{padding:11px 18px;cursor:pointer;font-size:12px;font-weight:500;color:#64748b;border-bottom:2px solid transparent}
.tab.on{color:#1a1a2e;border-bottom-color:#1a1a2e}
.panel{display:none;padding:24px 32px}.panel.on{display:block}
.filters{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.f{padding:4px 12px;border-radius:20px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-size:11px;color:#64748b;font-weight:500}
.f.on{background:#1a1a2e;color:#fff;border-color:#1a1a2e}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e2e8f0}
th{background:#f8fafc;padding:9px 14px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;text-transform:uppercase;letter-spacing:.04em}
td{padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
.badge{display:inline-block;padding:2px 7px;border-radius:4px;color:#fff;font-size:11px;font-weight:700;font-family:monospace}
.badge-sm{background:#fee2e2;color:#dc2626;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.mono{font-family:monospace;font-size:12px;word-break:break-all}
.muted{color:#94a3b8;font-size:11px}
.url-cell{display:flex;align-items:center;gap:8px}
.url-text{cursor:pointer;transition:color .15s}
.url-text:hover{color:#2563eb}
.url-text.copied{color:#16a34a}
.open-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:#f1f5f9;color:#475569;text-decoration:none;font-size:12px;flex-shrink:0;border:1px solid #e2e8f0;transition:all .15s}
.open-btn:hover{background:#dbeafe;color:#2563eb;border-color:#bfdbfe}
.group{background:#fff;border-radius:8px;margin-bottom:10px;border:1px solid #e2e8f0;overflow:hidden}
.group-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;cursor:pointer}
.group-body{padding:0}
.group-row{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid #f1f5f9;flex-wrap:wrap}
.group-row:last-child{border-bottom:none}
.empty{text-align:center;padding:60px;color:#94a3b8;font-size:15px}
input[type=text]{padding:6px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;width:320px;background:#fff;outline:none}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:8px 18px;border-radius:20px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
</style>
</head>
<body>
<div id="toast">Copied!</div>
<div class="topbar">
  <div><h1>Broken Link Report</h1><p>${startUrl} &nbsp;·&nbsp; ${new Date().toLocaleString()}</p></div>
  <div style="font-size:12px;color:#8892b0">${pageCount} pages crawled</div>
</div>
<div class="stats">
  <div class="stat"><div class="n">${all.length}</div><div class="l">Links checked</div></div>
  <div class="stat red"><div class="n">${broken.length}</div><div class="l">Broken</div></div>
  <div class="stat green"><div class="n">${ok.length}</div><div class="l">OK</div></div>
  <div class="stat"><div class="n">${pageCount}</div><div class="l">Pages crawled</div></div>
</div>
<div class="tabs">
  <div class="tab on" onclick="tab('grouped',this)">By page (${Object.keys(byPage).length})</div>
  <div class="tab" onclick="tab('table',this)">All broken (${broken.length})</div>
  <div class="tab" onclick="tab('ok',this)">OK (${ok.length})</div>
</div>
<div id="tab-grouped" class="panel on">
  ${broken.length === 0 ? '<div class="empty">🟢 No broken links found!</div>' : `
  <div class="filters">
    <span style="font-size:12px;color:#64748b;margin-right:4px">Filter:</span>
    <button class="f on" onclick="gFilter('all',this)">All</button>
    <button class="f" onclick="gFilter('500',this)">500</button>
    <button class="f" onclick="gFilter('404',this)">404</button>
    <button class="f" onclick="gFilter('TIMEOUT',this)">Timeout</button>
  </div>
  <div id="groups">${groupedHtml}</div>`}
</div>
<div id="tab-table" class="panel">
  ${broken.length === 0 ? '<div class="empty">🟢 No broken links found!</div>' : `
  <div class="filters">
    <button class="f on" onclick="tFilter('all',this)">All</button>
    <button class="f" onclick="tFilter('500',this)">500</button>
    <button class="f" onclick="tFilter('404',this)">404</button>
    <button class="f" onclick="tFilter('TIMEOUT',this)">Timeout</button>
    <input type="text" id="search" placeholder="Search URL…" oninput="searchTable()" style="margin-left:8px">
  </div>
  <table id="btable">
    <thead><tr><th>Status</th><th>Broken URL</th><th>Found on page</th><th>Time</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`}
</div>
<div id="tab-ok" class="panel">
  <table>
    <thead><tr><th>Status</th><th>URL</th><th>Time</th></tr></thead>
    <tbody>${ok.map((r) => `<tr>
      <td><span class="badge" style="background:#16a34a">${r.status}</span></td>
      <td class="url-cell">
        <span class="mono url-text" title="Click to copy" onclick="copyUrl('${r.url}',this)">${r.url.replace(origin, "")}</span>
        <a class="open-btn" href="${r.url}" target="_blank" rel="noopener">↗</a>
      </td>
      <td class="muted">${r.ms}ms</td>
    </tr>`).join("")}</tbody>
  </table>
</div>
<script>
function tab(n,el){document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));document.getElementById('tab-'+n).classList.add('on');el.classList.add('on');}
function tFilter(s,btn){document.querySelectorAll('.filters .f').forEach(b=>b.classList.remove('on'));btn.classList.add('on');document.querySelectorAll('#btable tbody tr').forEach(r=>{r.style.display=(s==='all'||r.dataset.status===s)?'':'none';});}
function searchTable(){const q=document.getElementById('search').value.toLowerCase();document.querySelectorAll('#btable tbody tr').forEach(r=>{r.style.display=r.innerText.toLowerCase().includes(q)?'':'none';});}
function gFilter(s,btn){document.querySelectorAll('.filters .f').forEach(b=>b.classList.remove('on'));btn.classList.add('on');document.querySelectorAll('.group').forEach(g=>{const rows=g.querySelectorAll('.group-row');let v=0;rows.forEach(r=>{const st=r.querySelector('.badge').textContent;const show=(s==='all'||st===s);r.style.display=show?'':'none';if(show)v++;});g.style.display=v?'':'none';});}
document.querySelectorAll('.group-header').forEach(h=>{h.addEventListener('click',()=>{const b=h.nextElementSibling;b.style.display=b.style.display==='none'?'':'none';});});
let toastTimer;
function copyUrl(url,el){
  navigator.clipboard.writeText(url).then(()=>{
    el.classList.add('copied');
    setTimeout(()=>el.classList.remove('copied'),1500);
    const t=document.getElementById('toast');
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>t.classList.remove('show'),1800);
  });
}
</script>
</body></html>`;
}

module.exports = { runCrawler };
