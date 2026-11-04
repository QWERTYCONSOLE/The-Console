const PROVIDER_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 4000;
const WEATHER_TIMEOUT_MS = 6000;
const SECRET_WORKER_URL = 'https://pegs.qwerty12345-1o1.workers.dev/'

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
      const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {}, HEALTH_TIMEOUT_MS);
      return { status: res.ok ? "active" : `error (${res.status})`, ok: res.ok };
    }
  } catch (e) {
    return { status: "network_error", ok: false };
  }
  return { status: "unknown", ok: false };
}

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

async function callGemini(key, messages) {
  if (!key) return { provider: "gemini", success: false, error: "no key" };
  try {
    let promptStr = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptStr }] }],
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
    let promptStr = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: "user", content: promptStr }]
    });
    return { provider: "cloudflare-ai", success: true, text: response.response };
  } catch (e) {
    return { provider: "cloudflare-ai", success: false, error: e.message };
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
      const promptText = (body.prompt || "").trim();
      let history = body.history || [];

      // --- CREATOR CHECK VIA SECRET WORKER ---
      let isCreator = false;
      try {
        const secretRes = await fetch(SECRET_WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: promptText })
        });
        if (secretRes.ok) {
          const secretData = await secretRes.json();
          if (secretData.isCreator) isCreator = true;
        }
      } catch (e) {}

      if (!isCreator && promptText.length > 4000) return json({ success: false, error: "Prompt too long" }, 413);

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

      let finalMessages = [...history];
      if (finalMessages.length === 0 || finalMessages[0].role !== "system") finalMessages.unshift({ role: "system", content: SYSTEM_PROMPT });

      if (!promptText) return json({ success: false, error: "Empty prompt" }, 400);

      let results = await Promise.all([
        callOpenAI(keys.openai, finalMessages),
        callOpenRouter(keys.openrouter, "nvidia/nemotron-3.5-super-vl:free", finalMessages),
        callOpenRouter(keys.openrouter, "recursive/flint-v1.0:free", finalMessages),
        callGroq(keys.groq, finalMessages, "openai/gpt-oss-120b"),
        callGroq(keys.groq, finalMessages, "openai/gpt-oss-20b"),
        callGroq(keys.groq, finalMessages, "openai/gpt-oss-safeguard-20b"),
        callCloudflareAI(env, finalMessages)
      ]);

      let successfulResponses = results.filter(r => r.success);

      if (successfulResponses.length === 0 && keys.gemini) {
        const geminiResult = await callGemini(keys.gemini, finalMessages);
        if (geminiResult.success) successfulResponses.push(geminiResult);
        else results.push(geminiResult);
      }

      if (successfulResponses.length > 0) return json({ success: true, responses: successfulResponses });

      return json({ success: false, error: "All cloud models failed. " + results.map(r => `${r.provider}: ${r.error}`).join(" | ") });
    } catch (err) {
      return json({ success: false, error: "Worker crash: " + err.message }, 500);
    }
  },
};
