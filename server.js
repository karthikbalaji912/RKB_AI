/* ==========================================================================
   RKB — Real-Time Knowledge Buddy AI
   server.js — Express backend (v4)
   --------------------------------------------------------------------------
   • Serves index.html as a single-page app
   • Secure /api/chat proxy (Demo / Ollama / OpenAI-compatible)
   • /api/vision       — vision analysis proxy
   • /api/action       — allowlisted desktop action validation
   • /api/dna/validate
   • /api/health
   API keys are read from process.env only. Never exposed to the client.
   ========================================================================== */

"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(express.json({ limit: "12mb" }));

/* --------------------------- Static --------------------------- */
const INDEX = path.join(__dirname, "index.html");

app.get("/", (req, res) => {
  if (!fs.existsSync(INDEX)) return res.status(500).send("index.html not found next to server.js");
  res.sendFile(INDEX);
});
app.get(/^\/(?!api\/).*/, (req, res) => {
  if (!fs.existsSync(INDEX)) return res.status(404).end();
  res.sendFile(INDEX);
});

/* --------------------------- Health --------------------------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "RKB",
    version: "4.0.0-phase4",
    providers: {
      chat: {
        demo: true,
        ollama: !!(process.env.OLLAMA_ENDPOINT || process.env.OLLAMA_API_KEY),
        openai: !!process.env.OPENAI_API_KEY
      },
      vision: {
        openai: !!process.env.OPENAI_API_KEY,
        ollama: !!(process.env.OLLAMA_ENDPOINT || process.env.OLLAMA_API_KEY)
      }
    },
    time: new Date().toISOString()
  });
});

/* --------------------------- DNA validate --------------------------- */
app.post("/api/dna/validate", (req, res) => {
  const dna = req.body;
  const errs = [];
  if (!dna || typeof dna !== "object") errs.push("Not an object");
  else {
    if (dna.product && dna.product !== "RKB") errs.push("product must be 'RKB'");
    if (dna.version != null && typeof dna.version !== "number") errs.push("version must be a number");
  }
  res.json({ ok: errs.length === 0, errors: errs });
});

/* --------------------------- Chat proxy --------------------------- */
const PROVIDER_DEFAULTS = {
  ollama: process.env.OLLAMA_ENDPOINT || "http://localhost:11434/v1/chat/completions",
  openai: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1") + "/chat/completions"
};
const EMOTION_KEYS = [
  "happy","excited","curious","confused","sad","angry","surprised",
  "focused","sleepy","proud","playful","calm","concerned"
];
function pickEmotionFromText(text, fallback = "calm") {
  const t = String(text || "");
  const table = [
    { emotion: "excited",   rx: /(let'?s go+|amazing|awesome|fantastic|won|winner|🥳|🔥|🎉|🚀)/i },
    { emotion: "happy",     rx: /(great|nice|good job|cool|love it|happy|glad|wonderful|perfect|thanks|thank you|super|semma|nalla)/i },
    { emotion: "proud",     rx: /(i did it|we did it|achieved|shipped|nailed it)/i },
    { emotion: "sad",       rx: /(sad|unfortunately|sorry|miss|:\(|😢|😔|fail)/i },
    { emotion: "angry",     rx: /(angry|furious|hate|damn|😡)/i },
    { emotion: "confused",  rx: /(confus|not sure|don'?t understand|huh\?|ennachu|enna problem|puriya)/i },
    { emotion: "surprised", rx: /(wow|whoa|no way|omg|😮|😲)/i },
    { emotion: "concerned", rx: /(tired|worried|scared|sick|tension|stress)/i },
    { emotion: "playful",   rx: /(bored|let'?s play|😂|🤣|joke)/i },
    { emotion: "curious",   rx: /(how|why|what|when|where|enna|eppadi|epdi)/i },
    { emotion: "focused",   rx: /(focus|study|coding|debug|working|research)/i },
    { emotion: "sleepy",    rx: /(sleep|good night|gn|thoong)/i }
  ];
  for (const r of table) if (r.rx.test(t)) return r.emotion;
  return fallback;
}

app.post("/api/chat", async (req, res) => {
  try {
    const {
      provider = "demo", endpoint, model, messages = [],
      temperature = 0.5, wantEmotion = false, mode = "universal"
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    if (provider === "demo") {
      const last = [...messages].reverse().find(m => m.role === "user");
      const text = typeof last?.content === "string"
        ? last.content
        : (Array.isArray(last?.content) ? last.content.find(p => p.type === "text")?.text : "") || "";
      const reply = demoBrain(text, mode);
      const emo = pickEmotionFromText(reply + " " + text, "calm");
      return res.json({
        provider: "demo", model: "rkb-demo-brain", mode,
        content: reply, emotion: emo,
        intensity: emo === "calm" ? 0.4 : 0.75,
        choices: [{ message: { role: "assistant", content: reply } }]
      });
    }

    const url = endpoint || PROVIDER_DEFAULTS[provider];
    if (!url) return res.status(400).json({ error: "No endpoint configured for provider " + provider });

    const headers = { "Content-Type": "application/json" };
    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return res.status(500).json({ error: "OPENAI_API_KEY not set on server" });
      headers.Authorization = "Bearer " + key;
    }
    if (provider === "ollama" && process.env.OLLAMA_API_KEY) headers.Authorization = "Bearer " + process.env.OLLAMA_API_KEY;

    let sendMessages = messages;
    if (wantEmotion) {
      sendMessages = [
        { role: "system", content: 'Also, after your reply, on a NEW line, output EXACTLY one JSON object like: {"emotion":"happy|excited|curious|confused|sad|angry|surprised|focused|sleepy|proud|playful|calm|concerned","intensity":0.0-1.0}. Do not put anything after the JSON.' },
        ...messages
      ];
    }

    const body = {
      model: model || (provider === "ollama" ? "llama3.2" : "gpt-4o-mini"),
      messages: sendMessages, temperature, stream: false
    };

    const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status).json({ error: "Upstream HTTP " + upstream.status, detail: text.slice(0, 800) });

    let data; try { data = JSON.parse(text); } catch { return res.status(502).json({ error: "Upstream returned non-JSON" }); }

    let content = data?.choices?.[0]?.message?.content ?? data?.message?.content ?? "";
    let emotion = null, intensity = null;
    if (content) {
      const m = content.match(/\{[\s\S]*?\}\s*$/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (parsed && EMOTION_KEYS.includes(parsed.emotion)) {
            emotion = parsed.emotion;
            intensity = typeof parsed.intensity === "number" ? parsed.intensity : 0.7;
            content = content.slice(0, m.index).trim();
          }
        } catch {}
      }
      if (!emotion) emotion = pickEmotionFromText(content, "calm");
    }

    res.json({ provider, model: body.model, mode, content, emotion,
      intensity: intensity ?? (emotion === "calm" ? 0.4 : 0.75), raw: data });
  } catch (err) {
    console.error("[RKB /api/chat] error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

/* --------------------------- Vision proxy --------------------------- */
app.post("/api/vision", async (req, res) => {
  try {
    const { provider = "demo", model, image, prompt } = req.body || {};
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ ok: false, error: "image data URL required" });
    }
    if (provider === "demo") {
      return res.json({ ok: true, provider: "demo", model: "rkb-vision-demo",
        analysis: "[DEMO] Vision AI is not configured. Configure OPENAI_API_KEY or OLLAMA_ENDPOINT for real image analysis." });
    }
    const instruction = prompt ? String(prompt).slice(0, 800)
      : "Briefly describe what you see in this screenshot. Note any code, text, or UI elements. Keep it short.";

    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
      const url = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1") + "/chat/completions";
      const body = {
        model: model || "gpt-4o-mini",
        messages: [{ role: "user", content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: image } }
        ]}],
        max_tokens: 400
      };
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ ok: false, error: "Upstream " + upstream.status });
      let data; try { data = JSON.parse(text); } catch { return res.status(502).json({ ok: false, error: "Non-JSON upstream" }); }
      return res.json({ ok: true, provider: "openai", model: body.model,
        analysis: data?.choices?.[0]?.message?.content || "" });
    }

    if (provider === "ollama") {
      const endpoint = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/v1/chat/completions";
      const body = {
        model: model || "llava",
        messages: [{ role: "user", content: instruction, images: [image.replace(/^data:image\/[a-z]+;base64,/, "")] }],
        stream: false
      };
      const headers = { "Content-Type": "application/json" };
      if (process.env.OLLAMA_API_KEY) headers.Authorization = "Bearer " + process.env.OLLAMA_API_KEY;
      const upstream = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ ok: false, error: "Upstream " + upstream.status });
      let data; try { data = JSON.parse(text); } catch { return res.status(502).json({ ok: false, error: "Non-JSON upstream" }); }
      return res.json({ ok: true, provider: "ollama", model: body.model,
        analysis: data?.choices?.[0]?.message?.content || data?.message?.content || "" });
    }
    res.status(400).json({ ok: false, error: "unknown provider" });
  } catch (err) {
    console.error("[RKB /api/vision] error:", err);
    res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

/* ============================================================
   RKB v4 — PERMISSION-GATED ACTION ENDPOINT
   The desktop shell calls this to VALIDATE actions before
   executing them. Never trust raw AI text — only allowlisted
   actions with clean parameters are accepted.
   ============================================================ */
const ACTION_ALLOWLIST = new Set([
  "OPEN_URL", "OPEN_APP", "OPEN_FOLDER",
  "COPY_TEXT", "READ_TEXT", "CREATE_NOTE", "START_TIMER"
]);
const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i;

app.post("/api/action", (req, res) => {
  try {
    const { action, params } = req.body || {};
    if (!ACTION_ALLOWLIST.has(action)) {
      return res.status(400).json({ ok: false, error: "action not allowed" });
    }
    if (action === "OPEN_URL") {
      const url = String(params?.url || "");
      if (!SAFE_URL.test(url)) return res.status(400).json({ ok: false, error: "invalid or unsafe url" });
      return res.json({ ok: true, action, url });
    }
    if (action === "OPEN_APP" || action === "OPEN_FOLDER") {
      const name = String(params?.name || params?.path || "").replace(/[^\w .:\/\\-~]/g, "");
      if (!name) return res.status(400).json({ ok: false, error: "missing name/path" });
      return res.json({ ok: true, action, name });
    }
    if (action === "COPY_TEXT" || action === "READ_TEXT" || action === "CREATE_NOTE") {
      const text = String(params?.text || "").slice(0, 4000);
      return res.json({ ok: true, action, text });
    }
    if (action === "START_TIMER") {
      const ms = Math.min(3_600_000, Math.max(1000, Number(params?.ms) || 60_000));
      return res.json({ ok: true, action, ms });
    }
    res.status(400).json({ ok: false, error: "unhandled action" });
  } catch (err) {
    console.error("[RKB /api/action] error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

/* --------------------------- Demo Brain --------------------------- */
function demoBrain(q, mode) {
  const x = String(q || "").toLowerCase();
  if (!x) return "I'm RKB — your Real-Time Knowledge Buddy AI. Ask me anything.";
  if (/(who are you|your name|introduce)/.test(x)) return "I'm RKB — Real-Time Knowledge Buddy AI, your customizable contextual companion.";
  if (/(hello|hi|hey|vanakkam|namaste)/.test(x)) return "Hey! 👋 I'm RKB AI. Ask me anything.";
  if (/(screen|watching|context)/.test(x)) return "Screen awareness uses browser getDisplayMedia with your explicit permission.";
  if (/(tanglish|tamil)/.test(x)) return "Tanglish mode is enabled in your language center.";
  if (/(hair|eyes|head|body|outfit|clothing)/.test(x)) return "Open Character Studio → customize me. Changes render instantly.";
  if (/(dna|export|import)/.test(x)) return "RKB DNA stores your complete identity. Use System → RKB DNA.";
  if (/(achievement|xp|level)/.test(x)) return "You can see achievements and XP in the LIFE section.";
  if (/(emotion|feeling|react)/.test(x)) return "I have an Emotion Engine — I react to what you say.";
  if (/(desktop|electron|tray|hotkey|always on top)/.test(x)) return "Desktop companion runs in Electron. Try System → Companion.";
  if (/(action|open|launch|timer|note)/.test(x)) return "I can suggest actions like opening YouTube, saving a note, or starting a timer. You'll be asked to approve.";
  if (/(movie|film|scene)/.test(x)) return "Movie Mode is available in the Mode Center.";
  if (/(study|learn|exam|revision)/.test(x)) return "Study Mode is available in the Mode Center.";
  if (/(code|coding|debug|error)/.test(x)) return "Coding Mode is available in the Mode Center.";
  if (/(panimalar|college|panads)/.test(x)) return "Panimalar Mode is available. Knowledge source not configured yet.";
  if (mode === "study") return "Ask me to explain, summarize, simplify or quiz.";
  if (mode === "coding") return "Paste code or drop a file. I'll explain, debug, optimize, or generate tests.";
  if (mode === "movie") return "Share a movie screen and ask 'who is that?' or 'explain this scene'.";
  return "I'm running in Demo Brain mode. Configure OPENAI_API_KEY or OLLAMA_ENDPOINT for real reasoning.";
}

/* --------------------------- Errors --------------------------- */
app.use((err, req, res, next) => {
  console.error("[RKB] Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

/* --------------------------- Listen --------------------------- */
app.listen(PORT, HOST, () => {
  console.log(`\n  ⚡ RKB — Real-Time Knowledge Buddy AI (v4)`);
  console.log(`  ➜ http://localhost:${PORT}\n`);
  console.log(`  Providers:`);
  console.log(`    • demo   (built-in)`);
  console.log(`    • ollama (env OLLAMA_ENDPOINT, OLLAMA_API_KEY)`);
  console.log(`    • openai (env OPENAI_API_KEY, OPENAI_BASE_URL)\n`);
  console.log(`  Actions:`);
  console.log(`    • allowlist: OPEN_URL, OPEN_APP, OPEN_FOLDER, COPY_TEXT, READ_TEXT, CREATE_NOTE, START_TIMER\n`);
});