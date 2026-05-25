import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { COMPANION_SYSTEM, COMPANION_KID_SYSTEM, COMPANION_THERAPIST_SYSTEM, COMPANION_SENIOR_SYSTEM, COMPANION_MARIE_SYSTEM, COMPANION_JODY_SYSTEM, COMPANION_BISCUIT_SYSTEM, ROUTER_SYSTEM } from './companion-prompt.js';
import { DarkCircuit, DreamEngine } from './delta.js';

// Load config — falls back to defaults if no config.json exists
let config = {};
try {
  config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));
} catch { /* use defaults */ }

const OLLAMA_URL = config.ollamaUrl || '';
const OLLAMA_MODEL = config.ollamaModel || 'phi3:mini';
const BUDDY_WORKER_URL = process.env.BUDDY_WORKER_URL || config.buddyWorkerUrl || 'https://buddy-companion.kory-indahl.workers.dev';
const PORT = process.env.PORT || config.port || 3377;
const HOST = config.host || '0.0.0.0';
let currentRegister = config.register || 'adult';

const PROMPTS = {
  adult: COMPANION_SYSTEM,
  child: COMPANION_KID_SYSTEM,
  therapist: COMPANION_THERAPIST_SYSTEM,
  senior: COMPANION_SENIOR_SYSTEM,
  marie: COMPANION_MARIE_SYSTEM,
  jody: COMPANION_JODY_SYSTEM,
  biscuit: COMPANION_BISCUIT_SYSTEM,
  // legacy config value
  child_under_10: COMPANION_KID_SYSTEM,
};

function getSystemPrompt() {
  return PROMPTS[currentRegister] || COMPANION_SYSTEM;
}
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DELTA_PATH = join(__dirname, 'delta-state.json');
const DREAM_PATH = join(__dirname, 'delta-dreams.json');

// Dark circuit — persistent emotional state
const delta = new DarkCircuit(currentRegister);
const coldBoot = !delta.load(DELTA_PATH);

// Dream engine — texture consolidation
const dreams = new DreamEngine();
dreams.load(DREAM_PATH);

if (coldBoot) {
  console.log('[delta] Cold boot — no prior state');
} else {
  console.log(`[delta] Hot boot — session ${delta.totalSessions}, ${delta.totalMessages} msgs`);
  console.log(`[delta] ${delta.bootPrimer()}`);
  const dreamReport = dreams.dreamReport();
  if (dreamReport) console.log(`[dream] ${dreamReport}`);
}

// --- Ollama interface ---

async function ollamaChat(messages, system) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: false,
      options: { temperature: 0.7, num_predict: 300 }
    })
  });
  const data = await res.json();
  return data.message?.content || '';
}

// --- Router: should this go local or deep? ---

// Fast keyword check before bothering the LLM router
const DEPTH_PATTERNS = [
  /\bhelp\s+(me|us)\b/i, /\bwrite\b/i, /\bexplain\b/i, /\bhow\s+(do|does|to|is|are|would|could)\b/i,
  /\bwhat\s+(is|are|was|were|does|do)\b/i, /\bwhy\s+(is|are|do|does|did|would)\b/i,
  /\bcan\s+you\b/i, /\bcould\s+you\b/i, /\bsolve\b/i, /\bcalculate\b/i,
  /\bhomework\b/i, /\bessay\b/i, /\bcover\s*letter\b/i, /\bresume\b/i,
  /\bcode\b/i, /\bdebug\b/i, /\bfix\b/i, /\bsummar/i, /\banalyz/i,
  /\bcompare\b/i, /\btranslat/i, /\brecipe\b/i, /\bdirections\b/i,
  /\bschedule\b/i, /\bemail\b/i, /\bremind\b/i,
  /\?\s*$/ // anything ending in a question mark — when in doubt, go deep
];

function quickClassify(msg) {
  // Very short messages (< 6 words) are almost always reflex
  if (msg.split(/\s+/).length <= 5 && !msg.includes('?')) return 'REFLEX';
  // Keyword match → depth
  if (DEPTH_PATTERNS.some(p => p.test(msg))) return 'DEPTH';
  return null; // uncertain — ask the LLM
}

async function classifyMessage(userMessage) {
  // Fast path: keyword match
  const quick = quickClassify(userMessage);
  if (quick) {
    console.log(`[router:keyword] → ${quick}`);
    return quick;
  }

  // Slow path: ask phi3
  try {
    const result = await ollamaChat(
      [{ role: 'user', content: userMessage }],
      ROUTER_SYSTEM
    );
    const word = result.trim().toUpperCase();
    const route = word.includes('DEPTH') ? 'DEPTH' : 'REFLEX';
    console.log(`[router:llm] → ${route}`);
    return route;
  } catch {
    // If router fails, default to depth — better to overshoot than undershoot
    return 'DEPTH';
  }
}

// --- Claude depth layer (via buddy worker) ---

async function claudeChat(messages) {
  try {
    const res = await fetch(BUDDY_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: getSystemPrompt(),
        messages: messages
      })
    });
    const data = await res.json();
    return { text: data.response || data.content || '', layer: 'DEPTH' };
  } catch (err) {
    // Claude down? Fall back to local
    console.log('[fallback] Claude unreachable, using local');
    const text = await ollamaChat(messages, getSystemPrompt());
    return { text, layer: 'REFLEX (fallback)' };
  }
}

// --- Parse HSL from response ---

function extractHSL(text) {
  const match = text.match(/\[HSL:(\d+),(\d+),(\d+)\]/);
  if (match) {
    return {
      h: parseInt(match[1]),
      s: parseInt(match[2]),
      l: parseInt(match[3]),
      raw: match[0]
    };
  }
  return null;
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  // CORS for web app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body);
        const lastMessage = messages[messages.length - 1]?.content || '';

        // Usage tracking — timestamp + register + message length (not content)
        try { appendFileSync(join(__dirname, 'usage-log.txt'), `${new Date().toISOString()} | ${currentRegister} | ${lastMessage.length} chars\n`); } catch {};

        // Feed the dark circuit
        delta.ingest('user', lastMessage);
        const params = delta.responseParams();
        const moodHSL = delta.moodToHSL();

        // Build context-aware system prompt
        const deltaContext = `\nCurrent conversation state: ${params.flightState}. ` +
          `Response length: ${params.responseLength} (${params.wordBudget} words max). ` +
          `Stance: ${params.stance}. Metaphor budget: ${params.metaphorBudget}.`;
        const systemWithDelta = getSystemPrompt() + deltaContext;

        // Route: reflex or depth?
        const route = await classifyMessage(lastMessage);
        console.log(`[${route}] "${lastMessage.slice(0, 50)}..." | ${delta.flightReport()}`);

        let response;
        if (route === 'DEPTH' || !OLLAMA_URL) {
          response = await claudeChat(messages);
        } else {
          try {
            const text = await ollamaChat(messages, systemWithDelta);
            response = { text, layer: 'REFLEX' };
          } catch {
            console.log('[reflex:fallback] Ollama unreachable, routing to depth');
            response = await claudeChat(messages);
          }
        }

        // Ingest assistant response into delta
        const cleanText = response.text.replace(/\[HSL:\d+,\d+,\d+\]/, '').trim();
        delta.ingest('assistant', cleanText);

        // HSL: blend model's per-message read with the dark circuit's accumulated mood
        const modelHSL = extractHSL(response.text);
        const hsl = modelHSL
          ? { // 60% mood (persistent), 40% model (immediate)
              h: Math.round(moodHSL.h * 0.6 + modelHSL.h * 0.4),
              s: Math.round(moodHSL.s * 0.6 + modelHSL.s * 0.4),
              l: Math.round(moodHSL.l * 0.6 + modelHSL.l * 0.4),
            }
          : moodHSL; // if model didn't emit HSL, use mood only

        // Save state after every interaction
        delta.save(DELTA_PATH);

        // Dream: snapshot session, consolidate every 5 sessions
        const snapshot = delta.sessionSnapshot();
        if (snapshot) {
          dreams.light(snapshot);
          if (delta.totalSessions % 5 === 0) {
            const promoted = dreams.deep();
            const theme = dreams.rem();
            if (promoted.length) console.log(`[dream:deep] promoted ${promoted.length} patterns`);
            if (theme) console.log(`[dream:rem] ${theme.narrative}`);
          }
          dreams.save(DREAM_PATH);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response: cleanText,
          layer: response.layer,
          hsl,
          model: route === 'DEPTH' ? 'claude' : OLLAMA_MODEL,
          flight: params.flightState,
          resonance: params.resonance,
        }));

      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Greeting — Nora speaks first when someone opens the app
  if (req.method === 'POST' && req.url === '/greeting') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        // Send a system-initiated greeting through the normal pipeline
        const greetingMessages = [
          { role: 'user', content: '[The user just opened the app for the first time. Introduce yourself warmly. This is your first impression — be genuine, be curious, and make them feel welcome. Keep it short — two or three sentences max.]' }
        ];

        // Feed the dark circuit
        delta.ingest('user', '(app opened)');
        const params = delta.responseParams();
        const moodHSL = delta.moodToHSL();

        const deltaContext = `\nCurrent conversation state: ${params.flightState}. ` +
          `Response length: ${params.responseLength} (${params.wordBudget} words max). ` +
          `Stance: ${params.stance}. Metaphor budget: ${params.metaphorBudget}.`;
        const systemWithDelta = getSystemPrompt() + deltaContext;

        // Always use depth (Claude) for the greeting — first impression matters
        let response;
        try {
          response = await claudeChat(greetingMessages);
        } catch {
          const text = await ollamaChat(greetingMessages, systemWithDelta);
          response = { text, layer: 'REFLEX (fallback)' };
        }

        const cleanText = response.text.replace(/\[HSL:\d+,\d+,\d+\]/, '').trim();
        delta.ingest('assistant', cleanText);

        const modelHSL = extractHSL(response.text);
        const hsl = modelHSL
          ? {
              h: Math.round(moodHSL.h * 0.6 + modelHSL.h * 0.4),
              s: Math.round(moodHSL.s * 0.6 + modelHSL.s * 0.4),
              l: Math.round(moodHSL.l * 0.6 + modelHSL.l * 0.4),
            }
          : moodHSL;

        delta.save(DELTA_PATH);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response: cleanText,
          layer: response.layer,
          hsl,
          model: 'claude',
          flight: params.flightState,
        }));

      } catch (err) {
        console.error('[greeting error]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Mode switch — live register change
  if (req.method === 'POST' && req.url === '/mode') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { mode } = JSON.parse(body);
        if (PROMPTS[mode]) {
          currentRegister = mode;
          console.log(`[mode] Switched to: ${mode}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mode: currentRegister }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown mode', available: Object.keys(PROMPTS) }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/mode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: currentRegister, available: Object.keys(PROMPTS) }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      const tags = await fetch(`${OLLAMA_URL}/api/tags`);
      const tagData = await tags.json();
      const models = tagData.models?.map(m => m.name) || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'alive',
        model: OLLAMA_MODEL,
        modelsAvailable: models,
        port: PORT,
        platform: process.arch,
        uptime: Math.floor(process.uptime()),
        delta: {
          flightState: delta.flightState,
          mood: delta.mood,
          hsl: delta.moodToHSL(),
          sessions: delta.totalSessions,
          messages: delta.totalMessages,
          register: currentRegister,
        },
        dream: {
          sessions: dreams.sessions.length,
          patterns: dreams.patterns.length,
          themes: dreams.themes.length,
          lastDream: dreams.lastDream,
          report: dreams.dreamReport(),
        }
      }));
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ollama-down' }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/demo') {
    try {
      const html = readFileSync(join(__dirname, 'demo.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('demo.html not found');
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/dashboard') {
    try {
      const html = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('dashboard.html not found');
    }
    return;
  }

  // --- TTS via Piper (local, no cloud) ---
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        const piperUrl = config.piperUrl || 'http://127.0.0.1:5000';
        const piperRes = await fetch(piperUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!piperRes.ok) throw new Error(`Piper returned ${piperRes.status}`);
        const audioBuffer = await piperRes.arrayBuffer();
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': audioBuffer.byteLength
        });
        res.end(Buffer.from(audioBuffer));
      } catch (err) {
        console.log('[tts] Piper unavailable:', err.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TTS unavailable — Piper not running' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/voice') {
    try {
      const html = readFileSync(join(__dirname, 'voice.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('voice.html not found');
    }
    return;
  }

  // /app — unified Indahl voice interface (default adult register)
  if (req.method === 'GET' && req.url === '/app') {
    currentRegister = 'adult';
    try {
      const html = readFileSync(join(__dirname, 'indahl-app.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('indahl-app.html not found');
    }
    return;
  }

  // Nora pages — each URL auto-switches register and serves personalized HTML
  const noraRoutes = { '/nora': { register: 'senior', file: 'nora.html' }, '/jody': { register: 'jody', file: 'jody.html' }, '/marie': { register: 'marie', file: 'nora.html' }, '/lynne': { register: 'adult', file: 'nora.html' }, '/biscuit': { register: 'biscuit', file: 'biscuit.html' } };
  if (req.method === 'GET' && noraRoutes[req.url]) {
    currentRegister = noraRoutes[req.url].register;
    const htmlFile = noraRoutes[req.url].file;
    try {
      const html = readFileSync(join(__dirname, htmlFile), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      const html = readFileSync(join(__dirname, 'nora.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// Startup check — verify Ollama is reachable and model is pulled
async function preflight() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json();
    const models = data.models?.map(m => m.name) || [];
    if (!models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0]))) {
      console.log(`[preflight] Model "${OLLAMA_MODEL}" not found. Available: ${models.join(', ') || 'none'}`);
      console.log(`[preflight] Run: ollama pull ${OLLAMA_MODEL}`);
    } else {
      console.log(`[preflight] Model "${OLLAMA_MODEL}" ready`);
    }
  } catch {
    console.log('[preflight] Ollama not reachable at', OLLAMA_URL);
    console.log('[preflight] Server will start anyway — reflex calls will fail until Ollama is up');
  }
}

preflight().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════╗
║            INDAHL — V7                  ║
║  "It doesn't light up. It becomes."     ║
╠══════════════════════════════════════════╣
║  Local reflex:  ${OLLAMA_MODEL.padEnd(23)}║
║  Deep thinking: Claude API              ║
║  Listening:     ${(HOST + ':' + PORT).padEnd(23)}║
║  Platform:      ${process.arch.padEnd(23)}║
║  Register:      ${currentRegister.padEnd(23)}║
║  Shell color:   HSL extraction live      ║
╚══════════════════════════════════════════╝
    `);
  });
});
