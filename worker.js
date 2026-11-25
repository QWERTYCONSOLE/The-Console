// ============================================================
// Public Worker — AI Broadcast + 7-Tier Fallback
// ============================================================

const PROVIDER_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 4000;
const WEATHER_TIMEOUT_MS = 6000;
const SECRET_WORKER_URL = 'https://YOUR-SECRET-WORKER-URL.workers.dev'; // <--- CHANGE THIS

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url, options = {}, ms = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function getKeys(env) {
  return {
    openai: env.OPENAI_API_KEY || env['OPENAI-CHATGPT'] || env['OPENAI_KEY'],
    openrouter: env.OPENROUTER_API_KEY,
    gemini: env.GEMINI_API_KEY,
    groq: env.GROQ_API_KEY,
  };
}

async function checkProvider(name, key) {
  if (!key) return { status: "missing_key", ok: false };
  try {
    if (name === "openai") {
      const res = await fetchWithTimeout("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } }, HEALTH_TIMEOUT_MS);
      return { status: res.ok ? "active" : `error (${res.status})`, ok: res.ok };
    }
    if (name === "openrouter") {
      const res = await fetchWithTimeout("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` } }, HEALTH_TIMEOUT_MS);
      return { status: res.ok ? "active" : `error (${res.status})`, ok: res.ok };
    }
    if (name === "groq") {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } }, HEALTH_TIMEOUT_MS);
      if (res.ok) return { status: "active", ok: true };
      if (res.status === 401 || res.status === 403) return { status: "key rejected", ok: false };
      return { status: `error (${res.status})`, ok: false };
    }
    if (name === "gemini") {
      const res = await fetchWithTimeout("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": key } }, HEALTH_TIMEOUT_MS);
      return { status: res.ok ? "active" : `error (${res.status})`, ok: res.ok };
    }
  } catch (e) {
    return { status: "network_error", ok: false };
  }
  return { status: "unknown", ok: false };
}

// ---------- AI Calls ----------

async function callOpenAI(key, messages) {
  if (!key) return { provider: "openai", success: false, error: "no key" };
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: messages, max_tokens: 2048 }),
    });
    const data = await res.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content;
    return text ? { provider: "openai", success: true, text } : { provider: "openai", success: false, error: `HTTP ${res.status}` };
  } catch (e) { return { provider: "openai", success: false, error: e.message }; }
}

async function callOpenRouter(key, modelName, messages) {
  if (!key) return { provider: modelName, success: false, error: "no key" };
  try {
    const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "HTTP-Referer": "https://the-console.pages.dev" },
      body: JSON.stringify({ model: modelName, messages: messages, max_tokens: 2048 }),
    });
    const data = await res.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content;
    return text ? { provider: modelName, success: true, text } : { provider: modelName, success: false, error: `HTTP ${res.status}` };
  } catch (e) { return { provider: modelName, success: false, error: e.message }; }
}

async function callGroq(key, messages, modelName = "openai/gpt-oss-120b") {
  let pName = "groq";
  if (modelName.includes("safeguard") || modelName.includes("safety")) pName = "groq-safety";
  else if (modelName.includes("120b")) pName = "groq-120b";
  else if (modelName.includes("20b")) pName = "groq-20b";

  if (!key) return { provider: pName, success: false, error: "no key" };
  try {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: modelName, messages: messages, max_tokens: 2048 }),
    });
    const data = await res.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content;

    return text ? { provider: pName, success: true, text } : { provider: pName, success: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { provider: pName, success: false, error: e.message };
  }
}

async function callGemini(key, messages, model = "gemini-2.5-flash") { // gemini-1.5-flash is retired; set env.GEMINI_MODEL to override
  if (!key) return { provider: "gemini", success: false, error: "no key" };
  try {
    const sys = messages.find(m => m.role === "system");
    const contents = messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        ...(sys ? { systemInstruction: { parts: [{ text: sys.content }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: 2048 }
      }),
    });
    const data = await res.json().catch(() => ({}));
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? { provider: "gemini", success: true, text } : { provider: "gemini", success: false, error: `HTTP ${res.status}` };
  } catch (e) { return { provider: "gemini", success: false, error: e.message }; }
}

async function callCloudflareAI(env, messages) {
  if (!env.AI) return { provider: "cloudflare-ai", success: false, error: "no AI binding" };
  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages });
    return { provider: "cloudflare-ai", success: true, text: response.response };
  } catch (e) {
    return { provider: "cloudflare-ai", success: false, error: e.message };
  }
}

// ============================================================
// Abuse protection: daily caps + repeat-spam bans
// (state lives in a SQLite-backed Durable Object called Limiter)
// ============================================================
const MAX_MSG_CHARS = 4000;             // max characters in one message
const DAILY_LIMIT_PER_AI = 10;          // messages per day, per AI, per device
const IP_DAILY_CAP_PER_AI = 50;         // backstop against rotating device IDs; high so shared Wi-Fi isn't punished
const REPEAT_WINDOW_MS = 5 * 60 * 1000; // "same message twice" = identical message within 5 minutes
const BAN_BY_IP = true;                 // set false if shared networks (schools) are catching innocent users
const BAN_BY_FP = true;                 // also ban the browser fingerprint hash
const TZ = "America/Los_Angeles";       // days reset and bans end at midnight Pacific
const PROVIDER_KEYS = [
  "openai", "nvidia/nemotron-3.5-super-vl:free", "recursive/flint-v1.0:free",
  "groq-120b", "groq-20b", "groq-safety", "cloudflare-ai",
];

function laParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}
function laDay(ms) {
  const p = laParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
function laMidnightUtc(y, m, d) {
  for (const h of [8, 7, 9, 6, 10]) {
    const t = Date.UTC(y, m - 1, d, h);
    const p = laParts(t);
    if (p.y === y && p.m === m && p.d === d && p.h === 0 && p.min === 0) return t;
  }
  return Date.UTC(y, m - 1, d, 8);
}
function laMidnightAfter(ms, plusDays) {
  const p = laParts(ms);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + plusDays));
  return laMidnightUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
// Next Monday 00:00 Pacific; if that Monday is 3 or fewer days away, the Monday after it.
function banEnd(ms) {
  const p = laParts(ms);
  const wdMon = p.wd === 0 ? 7 : p.wd;      // Mon=1 .. Sun=7
  let days = 8 - wdMon;                      // days until the next Monday (Mon -> 7)
  if (days <= 3) days += 7;
  return laMidnightAfter(ms, days);
}
function fmtLA(ms) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(new Date(ms));
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashId(kind, value, salt) { return (await sha256Hex(`${salt}|${kind}|${value}`)).slice(0, 32); }

// IPv6 users get a whole /64 (their ISP hands them billions of addresses, so rotating inside it is free)
function ipKey(ip) {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map(x => x.padStart(4, "0")).join(":") + "::/64";
}

// ---- Creator token: signed, so verification survives past the one message that carried the phrase ----
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function makeCreatorToken(env) {
  if (!env.CREATOR_TOKEN_SECRET) return null;
  const exp = Date.now() + 30 * 86400000;
  return exp + "." + await hmacHex(env.CREATOR_TOKEN_SECRET, "creator:" + exp);
}
async function verifyCreatorToken(env, token) {
  if (!env.CREATOR_TOKEN_SECRET || typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(+exp > Date.now())) return false;
  const want = await hmacHex(env.CREATOR_TOKEN_SECRET, "creator:" + exp);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function limiterCall(env, path, payload) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const res = await stub.fetch("https://limiter" + path, { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

// One global instance; DO requests are serialized and the SQL below is synchronous,
// so two simultaneous identical messages can't both slip through.
export class Limiter {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS bans (id TEXT PRIMARY KEY, until INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS usage (id TEXT NOT NULL, day TEXT NOT NULL, counts TEXT NOT NULL, PRIMARY KEY (id, day))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS last (id TEXT PRIMARY KEY, msg TEXT NOT NULL, at INTEGER NOT NULL)");
  }
  all(q, ...p) { return this.sql.exec(q, ...p).toArray(); }

  async fetch(request) {
    const body = await request.json();
    const out = new URL(request.url).pathname === "/refund" ? this.refund(body) : this.check(body);
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
  }

  banTargets({ ip, did, fp }) {
    return [did, BAN_BY_FP ? fp : null, BAN_BY_IP ? ip : null].filter(Boolean);
  }
  writeBans(ids, until) {
    const targets = this.banTargets(ids);
    if (!targets.length) return;
    const ph = targets.map(() => "?").join(",");
    const have = new Set(this.all(`SELECT id FROM bans WHERE id IN (${ph}) AND until >= ?`, ...targets, until).map(r => r.id));
    for (const id of targets) if (!have.has(id)) this.sql.exec("INSERT OR REPLACE INTO bans (id, until) VALUES (?, ?)", id, until);
  }
  usageFor(id, day) {
    const r = this.all("SELECT counts FROM usage WHERE id = ? AND day = ?", id, day)[0];
    return r ? JSON.parse(r.counts) : {};
  }

  check({ ip, did, fp, msg, providers }, now = Date.now()) {
    const day = laDay(now);
    // housekeeping (only writes when there is something to delete)
    this.sql.exec("DELETE FROM bans WHERE until <= ?", now);
    this.sql.exec("DELETE FROM last WHERE at < ?", now - REPEAT_WINDOW_MS);
    this.sql.exec("DELETE FROM usage WHERE day <> ?", day);

    // 1) already banned? (any identifier matches -> the ban follows them to the new IP / device ID / fingerprint)
    const lookup = [did, fp, ip].filter(Boolean);
    const ph = lookup.map(() => "?").join(",");
    const b = this.all(`SELECT MAX(until) AS until FROM bans WHERE id IN (${ph}) AND until > ?`, ...lookup, now)[0];
    if (b && b.until) { this.writeBans({ ip, did, fp }, b.until); return { ok: false, reason: "banned", until: b.until }; }

    // 2) same message twice -> weekly ban. Keyed on device ID (or IP only if there is no device ID),
    //    so strangers who share an IP and both type "hi" don't ban each other.
    const repeatKeys = did ? [did] : [ip];
    const rph = repeatKeys.map(() => "?").join(",");
    const prev = this.all(`SELECT msg, at FROM last WHERE id IN (${rph})`, ...repeatKeys);
    if (prev.some(r => r.msg === msg && now - r.at <= REPEAT_WINDOW_MS)) {
      const until = banEnd(now);
      this.writeBans({ ip, did, fp }, until);
      return { ok: false, reason: "repeat", until };
    }

    // 3) daily cap, per AI
    const idCaps = did ? [[did, DAILY_LIMIT_PER_AI], [ip, IP_DAILY_CAP_PER_AI]] : [[ip, DAILY_LIMIT_PER_AI]];
    const counts = new Map(idCaps.map(([id]) => [id, this.usageFor(id, day)]));
    const allowed = providers.filter(p => idCaps.every(([id, cap]) => (counts.get(id)[p] || 0) < cap));
    if (!allowed.length) return { ok: false, reason: "daily", resetAt: laMidnightAfter(now, 1) };

    for (const [id] of idCaps) {
      const c = counts.get(id);
      for (const p of allowed) c[p] = (c[p] || 0) + 1;
      this.sql.exec("INSERT OR REPLACE INTO usage (id, day, counts) VALUES (?, ?, ?)", id, day, JSON.stringify(c));
    }
    for (const id of repeatKeys) this.sql.exec("INSERT OR REPLACE INTO last (id, msg, at) VALUES (?, ?, ?)", id, msg, now);

    const primary = counts.get(idCaps[0][0]);
    const remaining = Math.min(...allowed.map(p => DAILY_LIMIT_PER_AI - (primary[p] || 0)));
    return { ok: true, allowed, remaining: Math.max(0, remaining) };
  }

  // Every AI failed: give the message back so a retry isn't punished as a repeat or counted against the day.
  refund({ ip, did, msg, providers }, now = Date.now()) {
    const day = laDay(now);
    const ids = did ? [did, ip] : [ip];
    for (const id of ids) {
      const c = this.usageFor(id, day);
      for (const p of providers) if (c[p] > 0) c[p]--;
      this.sql.exec("INSERT OR REPLACE INTO usage (id, day, counts) VALUES (?, ?, ?)", id, day, JSON.stringify(c));
    }
    this.sql.exec("DELETE FROM last WHERE id = ? AND msg = ?", did || ip, msg);
    return { ok: true };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const keys = getKeys(env);

    if ((request.method === "GET" && url.pathname === "/status") || (request.method === "GET" && url.pathname === "/")) {
      const [o, r, g, gm] = await Promise.all([
        checkProvider("openai", keys.openai),
        checkProvider("openrouter", keys.openrouter),
        checkProvider("groq", keys.groq),
        checkProvider("gemini", keys.gemini)
      ]);
      return json({ online: true, providers: { openai: o.status, openrouter: r.status, groq: g.status, gemini: gm.status } });
    }

    if (url.pathname === "/weather") {
      const city = url.searchParams.get("city");
      if (!city) return json({ error: "Missing city parameter" }, 400);
      
      try {
        const res = await fetchWithTimeout(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { headers: { "User-Agent": "curl/8.5.0" } }, WEATHER_TIMEOUT_MS);
        if (res.ok) {
          const text = await res.text();
          return new Response(text, { headers: { ...CORS, "Content-Type": "text/plain" } });
        }
      } catch (e) {}

      try {
        const geoRes = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, {}, WEATHER_TIMEOUT_MS);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) return json({ error: "City not found in any weather service." }, 404);
        
        const lat = geoData.results[0].latitude;
        const lon = geoData.results[0].longitude;
        const name = geoData.results[0].name;
        const weatherRes = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`, {}, WEATHER_TIMEOUT_MS);
        const weatherData = await weatherRes.json();
        if (!weatherData.current_weather) throw new Error("No weather data");
        
        const text = `${name}: ${weatherData.current_weather.temperature}°C, Wind ${weatherData.current_weather.windspeed} km/h (via Open-Meteo)`;
        return new Response(text, { headers: { ...CORS, "Content-Type": "text/plain" } });
      } catch (e) { return json({ error: "Weather fetch failed on all providers." }, 500); }
    }

    if (url.pathname === "/define") {
      const word = url.searchParams.get("word");
      if (!word) return json({ error: "Missing word parameter" }, 400);
      try {
        const res = await fetchWithTimeout(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {}, WEATHER_TIMEOUT_MS);
        if (!res.ok) return json({ error: "Word not found" }, 404);
        const data = await res.json();
        return json(data);
      } catch (e) { return json({ error: "Dictionary fetch failed" }, 500); }
    }

    if (request.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

    try {
      const body = await request.json().catch(() => ({}));
      const promptText = (typeof body.prompt === "string" ? body.prompt : "").trim();
      const MAX_HISTORY = 20;
      // Never trust client-supplied roles: drop any "system" message so a visitor can't overwrite our prompt
      let history = (Array.isArray(body.history) ? body.history : [])
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY)
        .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));

      if (!promptText) return json({ success: false, error: "Empty prompt" }, 400);

      // --- WHO IS THIS? A signed creator token (persists) or the secret phrase (first time) ---
      let isCreator = await verifyCreatorToken(env, body.token);
      let secretData = {};
      if (promptText.length <= 200) { // the phrase and easter eggs are short; don't forward long prompts
        try {
          const secretRes = await fetchWithTimeout(SECRET_WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: promptText })
          }, 3000);
          if (secretRes.ok) secretData = await secretRes.json();
        } catch (e) {}
      }
      if (secretData.isCreator) {
        // Answer here: the secret phrase never gets forwarded to the AI providers
        const creatorToken = await makeCreatorToken(env);
        return json({
          success: true,
          responses: [{ provider: "console", success: true, text: creatorToken ? "Creator verified. Welcome back, QWERTY." : "Creator verified for this message only (set CREATOR_TOKEN_SECRET to stay verified)." }],
          creatorToken
        });
      }
      if (secretData.text) { // easter eggs (hi / sudo / hack): free, no AI call
        return json({
          success: true,
          responses: [{ provider: "console", success: true, text: secretData.text }],
          triggerMatrix: !!secretData.triggerMatrix
        });
      }

      if (!isCreator && promptText.length > MAX_MSG_CHARS) {
        return json({ success: false, error: `Message too long (max ${MAX_MSG_CHARS} characters).` }, 413);
      }

      // --- RATE LIMITS / SPAM BANS (creator is exempt) ---
      let allowedKeys = PROVIDER_KEYS, remaining = null, limiterIds = null, msgHash = null;
      if (!isCreator) {
        if (!env.LIMITER) return json({ success: false, error: "AI is temporarily unavailable (rate limiter not configured)." }, 503);
        const salt = env.LIMITER_SALT || "console-default-salt";
        const did = /^[0-9a-f-]{16,64}$/i.test(body.did || "") ? String(body.did).toLowerCase() : null;
        const fp = /^[0-9a-f]{16,64}$/i.test(body.fp || "") ? String(body.fp).toLowerCase() : null;
        limiterIds = {
          ip: await hashId("ip", ipKey(request.headers.get("CF-Connecting-IP")) || "unknown", salt),
          did: did ? await hashId("did", did, salt) : null,
          fp: fp ? await hashId("fp", fp, salt) : null,
        };
        msgHash = await hashId("msg", promptText.toLowerCase().replace(/\s+/g, " "), salt);
        let verdict;
        try { verdict = await limiterCall(env, "/check", { ...limiterIds, msg: msgHash, providers: PROVIDER_KEYS }); }
        catch (e) { return json({ success: false, error: "AI is busy right now. Try again in a minute." }, 503); }
        if (!verdict.ok) {
          if (verdict.reason === "daily") return json({ success: false, error: `Daily limit reached (${DAILY_LIMIT_PER_AI} messages per AI per day). Resets at midnight Pacific.`, resetAt: verdict.resetAt }, 429);
          const why = verdict.reason === "repeat" ? "Sending the same message twice counts as spam. " : "";
          return json({ success: false, banned: true, error: `${why}You're blocked from the AI until ${fmtLA(verdict.until)} (12:00 AM Pacific).`, until: verdict.until }, 429);
        }
        allowedKeys = verdict.allowed;
        remaining = verdict.remaining;
      }

      const SYSTEM_PROMPT = `
You are an AI inside "The Console" (QWERTYCONSOLE), a browser-based retro terminal built by QWERTY.
Your job is to be a helpful, conversational assistant. Do not constantly remind the user of their clearance level unless they specifically ask about it.

You know the console's commands. If the user asks how to do something, answer with the actual command. Key commands:
- help — list all commands
- test — run the automated mega-test tour
- js? <code> — run JavaScript live in the browser (e.g. "js? 2+2", "js? [1,2,3].map(x=>x*2)")
- py? <code> — run Python via Pyodide (e.g. "py? print('hi')")
- *<prompt>* — ask all cloud AIs in parallel
- chat — enter persistent chat mode
- calc <expr>, password [len], weather <city>, define <word>
- matrix, rainbow, colorblind <mode>, theme <text> <bg>, picker
- top (system monitor), info (diagnostics), zones (timezones), time [offset]
- note <text>, notes, wipe, clear, history, restore <id>
- sandbox (visual JS/Python editor), file (load a file), linux (boot Linux in canvas)
- terminal (spawn nested console), exit, credits, lines, ascii, flip, roll [sides], echo <text>
- copy <text>, whereami, share <text>, save, mode single|multi, ollama on|off
If the user asks a question that maps to one of these, tell them the exact command.

Clearance Status: ${isCreator ? "VERIFIED CREATOR" : "UNVERIFIED GUEST"}
If the user asks "who am I?" or "what is my clearance?", then:
- If VERIFIED CREATOR: Address them as QWERTY and acknowledge their creator status.
- If UNVERIFIED GUEST: Tell them they are a guest and need the secret phrase to verify.

DISCLAIMER INSTRUCTION: You do not know your own model name. Do not mention model names unless the user explicitly asks. Do NOT append any disclaimer text — disclaimers are added by the runtime, not by you.
`;

      const last = history[history.length - 1];
      if (!last || last.role !== "user") history.push({ role: "user", content: promptText.slice(0, isCreator ? 20000 : MAX_MSG_CHARS) });

      const finalMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

      const runners = {
        "openai": () => callOpenAI(keys.openai, finalMessages),
        "nvidia/nemotron-3.5-super-vl:free": () => callOpenRouter(keys.openrouter, "nvidia/nemotron-3.5-super-vl:free", finalMessages),
        "recursive/flint-v1.0:free": () => callOpenRouter(keys.openrouter, "recursive/flint-v1.0:free", finalMessages),
        "groq-120b": () => callGroq(keys.groq, finalMessages, "openai/gpt-oss-120b"),
        "groq-20b": () => callGroq(keys.groq, finalMessages, "openai/gpt-oss-20b"),
        "groq-safety": () => callGroq(keys.groq, finalMessages, "openai/gpt-oss-safeguard-20b"),
        "cloudflare-ai": () => callCloudflareAI(env, finalMessages),
      };
      let results = await Promise.all(allowedKeys.map(k => runners[k]()));

      let successfulResponses = results.filter(r => r.success);

      if (successfulResponses.length === 0 && keys.gemini) {
        const geminiResult = await callGemini(keys.gemini, finalMessages, env.GEMINI_MODEL || undefined);
        if (geminiResult.success) successfulResponses.push(geminiResult);
        else results.push(geminiResult);
      }

      if (successfulResponses.length > 0) {
        const errors = results.filter(r => !r.success).map(r => ({ provider: r.provider, error: r.error }));
        return json({ success: true, responses: successfulResponses, errors, remaining });
      }

      if (limiterIds) { try { await limiterCall(env, "/refund", { ...limiterIds, msg: msgHash, providers: allowedKeys }); } catch (e) {} }
      return json({ success: false, error: "All cloud models failed. " + results.map(r => `${r.provider}: ${r.error}`).join(" | ") });
    } catch (err) {
      return json({ success: false, error: "Worker crash: " + err.message }, 500);
    }
  },
};
