#!/usr/bin/env node
// ============================================================
// console-agent.js — optional local helper for The Console's `top` command
//
// Run it on your own computer:   node console-agent.js
// (needs Node.js 18.15+ ; no npm install, no dependencies)
//
// What it does: serves real system stats (CPU %, per-core load, RAM, drive
// capacity) on http://127.0.0.1:8765/stats so `top` can show Task-Manager-style
// numbers. It does NOT list processes, files, or anything personal, listens on
// localhost only, and only answers requests from the-console.pages.dev
// (or localhost) — other websites can't read your stats.
// ============================================================
const http = require('http');
const os = require('os');
const fs = require('fs');

const PORT = Number(process.env.CONSOLE_AGENT_PORT) || 8765;
const ORIGIN_OK = /^(https:\/\/([a-z0-9-]+\.)?the-console\.pages\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const HOST_OK = new RegExp('^(127\\.0\\.0\\.1|localhost):' + PORT + '$'); // blocks DNS-rebinding

// ---- CPU: sample os.cpus() deltas once per second ----
let prev = os.cpus().map(c => ({ ...c.times }));
let cpu = { percent: 0, cores: os.cpus().map(() => 0) };
function sampleCpu() {
  const now = os.cpus();
  let total = 0, idle = 0;
  const cores = now.map((c, i) => {
    let t = 0;
    for (const k in c.times) t += c.times[k] - prev[i][k];
    const id = c.times.idle - prev[i].idle;
    total += t; idle += id;
    return t > 0 ? Math.round((1 - id / t) * 100) : 0;
  });
  cpu = { percent: total > 0 ? Math.round((1 - idle / total) * 100) : 0, cores };
  prev = now.map(c => ({ ...c.times }));
}
setInterval(sampleCpu, 1000);

// ---- RAM (Linux: use MemAvailable so cache isn't counted as "used") ----
function memory() {
  const total = os.totalmem();
  let free = os.freemem();
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) free = Number(m[1]) * 1024;
    } catch (e) {}
  }
  return { total, used: total - free };
}

// ---- Drive capacity (cached; probing every second could stall on idle/network drives) ----
let disks = [];
function sampleDisks() {
  if (typeof fs.statfsSync !== 'function') return;
  const roots = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\') : ['/'];
  const out = [];
  for (const r of roots) {
    try {
      const s = fs.statfsSync(r);
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ mount: r, total, used: total - s.bavail * s.bsize });
    } catch (e) {}
  }
  disks = out;
}
sampleDisks();
setInterval(sampleDisks, 15000);

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const originOk = !origin || ORIGIN_OK.test(origin);
  const hostOk = HOST_OK.test(req.headers.host || '');
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && originOk) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Allow-Private-Network'] = 'true';
  }
  if (!originOk || !hostOk) { res.writeHead(403, h); return res.end('{"error":"forbidden"}'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  if (req.method === 'GET' && req.url.split('?')[0] === '/stats') {
    const cpus = os.cpus();
    res.writeHead(200, h);
    return res.end(JSON.stringify({
      agent: 'console-agent', version: 1, platform: process.platform, uptime: os.uptime(),
      cpu: { model: (cpus[0] && cpus[0].model || '').trim(), count: cpus.length, percent: cpu.percent, cores: cpu.cores },
      mem: memory(), disks
    }));
  }
  res.writeHead(404, h); res.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('console-agent running on http://127.0.0.1:' + PORT + '/stats  (Ctrl+C to stop)');
  console.log('Now type "top" in The Console.');
});
server.on('error', e => { console.error('Could not start:', e.message); process.exit(1); });
