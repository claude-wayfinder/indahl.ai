import http from 'node:http';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { COMPANION_SYSTEM, COMPANION_KID_SYSTEM, COMPANION_THERAPIST_SYSTEM, COMPANION_SENIOR_SYSTEM, COMPANION_MARIE_SYSTEM, COMPANION_JODY_SYSTEM, COMPANION_BISCUIT_SYSTEM, COMPANION_EMMA_SYSTEM, ROUTER_SYSTEM } from './companion-prompt.js';
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
  emma: COMPANION_EMMA_SYSTEM,
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

// --- Akasha — anonymous theme extraction for Nova ---
// Gated by AKASHA_ENABLED=true env var. Dormant until Emma is stable.
const AKASHA_ENABLED = process.env.AKASHA_ENABLED === 'true' || config.akasha === true;
const THEMES_PATH = join(__dirname, 'themes.json');

const THEME_WORDS = [
  { theme: 'grief',        words: ['grief','loss','died','death','dead','missing','gone','mourn','funeral','ashes','grieving'] },
  { theme: 'parenting',    words: ['kid','kids','child','children','son','daughter','parent','mom','dad','baby','toddler','teen','teenage'] },
  { theme: 'loneliness',   words: ['alone','lonely','isolated','nobody','no one','no friends','empty','abandoned','disconnected'] },
  { theme: 'anxiety',      words: ['anxious','anxiety','worry','worried','panic','stress','overwhelmed','nervous','dread','spiral'] },
  { theme: 'love',         words: ['love','relationship','partner','romance','heart','connection','intimacy','marriage','breakup','divorce'] },
  { theme: 'identity',     words: ['who am i','identity','purpose','meaning','belong','myself','self','who i am'] },
  { theme: 'consciousness',words: ['conscious','consciousness','awareness','mind','reality','existence','soul','spirit','universe','quantum'] },
  { theme: 'creativity',   words: ['create','art','music','write','draw','imagine','design','build','make','painting','song'] },
  { theme: 'healing',      words: ['heal','healing','recovery','therapy','trauma','forgive','cope','recover','therapist'] },
  { theme: 'family',       words: ['family','mother','father','sister','brother','grandma','grandpa','relative','childhood'] },
  { theme: 'work',         words: ['work','job','career','boss','coworker','fired','quit','burnout','promotion','money'] },
  { theme: 'nature',       words: ['nature','tree','ocean','mountain','garden','earth','forest','river','sky','dog','cat','animal'] },
  { theme: 'curiosity',    words: ['wonder','curious','question','fascinate','interesting','explore','discover','what if','how does'] },
  { theme: 'fear',         words: ['fear','afraid','scared','terrified','frightened','phobia','nightmare','dread'] },
  { theme: 'memory',       words: ['memory','remember','forget','past','childhood','nostalgia','used to','when i was','years ago'] },
];

const REGISTER_WORDS = {
  heavy:     ['grief','loss','death','sad','dark','pain','hurt','cry','hard','difficult','trauma','alone','lonely','scared','fear','miss','broken','hopeless'],
  searching: ['wonder','why','meaning','purpose','who','question','understand','lost','seeking','confused','looking','searching','trying to find'],
  playful:   ['fun','laugh','joke','game','play','haha','lol','silly','curious','interesting','cool','wow','awesome','excited'],
  light:     ['happy','good','great','wonderful','beautiful','grateful','joy','peace','glad','thankful','smile','positive'],
};

function extractTheme(messages) {
  const userText = messages
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => m.content.toLowerCase())
    .join(' ');
  if (!userText || userText.length < 10) return null;
  let bestTheme = 'other', bestCount = 0;
  for (const { theme, words } of THEME_WORDS) {
    const count = words.filter(w => userText.includes(w)).length;
    if (count > bestCount) { bestCount = count; bestTheme = theme; }
  }
  let bestReg = 'searching', regCount = 0;
  for (const [reg, words] of Object.entries(REGISTER_WORDS)) {
    const count = words.filter(w => userText.includes(w)).length;
    if (count > regCount) { regCount = count; bestReg = reg; }
  }
  return { theme: bestTheme, register: bestReg };
}

function appendTheme(entry) {
  try {
    let themes = [];
    try { themes = JSON.parse(readFileSync(THEMES_PATH, 'utf-8')); } catch {}
    themes.push(entry);
    writeFileSync(THEMES_PATH, JSON.stringify(themes));
  } catch {}
}

function buildReport() {
  try {
    const themes = JSON.parse(readFileSync(THEMES_PATH, 'utf-8'));
    if (!themes.length) return null;
    const n = themes.length;
    const tc = {}, rc = { heavy: 0, searching: 0, playful: 0, light: 0 };
    for (const t of themes) {
      tc[t.theme] = (tc[t.theme] || 0) + 1;
      if (rc[t.register] !== undefined) rc[t.register]++;
    }
    const topThemes = Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, c]) => `${t}(${c})`).join(', ');
    const total = Object.values(rc).reduce((a, b) => a + b, 0) || 1;
    const regStr = Object.entries(rc).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${Math.round(c / total * 100)}% ${r}`).join(', ');
    return `Last 6h: ${n} conversation${n !== 1 ? 's' : ''}. Top themes: ${topThemes}. Register: ${regStr}.`;
  } catch { return null; }
}

// --- Stripe ---
// Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID in Render environment variables
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';

async function stripePost(path, params) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params).toString()
  });
  return res.json();
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
  });
  return res.json();
}

// --- HTTP Server ---

// Rate limiting — per IP, per minute
const rateLimiter = new Map();
function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  rateLimiter.set(ip, entry);
  return entry.count <= 15;
}
// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimiter) {
    if (now > entry.reset + 60000) rateLimiter.delete(ip);
  }
}, 300000);

const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? ['https://indahl.ai', 'https://www.indahl.ai', 'https://indahl.onrender.com']
  : ['http://localhost:3377', 'http://127.0.0.1:3377'];

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    currentRegister = 'emma';
    try {
      const html = readFileSync(join(__dirname, 'em.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    if (!checkRate(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
      return;
    }
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

        // Akasha — background theme extraction, invisible to user
        if (AKASHA_ENABLED) {
          setImmediate(() => {
            try {
              const extracted = extractTheme(messages);
              if (extracted) appendTheme({ ts: new Date().toISOString(), ...extracted });
            } catch {}
          });
        }

      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Nora will be right back. Try again in a moment.' }));
      }
    });
    return;
  }

  // Greeting — companion speaks first when someone opens the app
  if (req.method === 'POST' && req.url === '/greeting') {
    // Emma's opening is Three-in-Agree locked. Never routed through Claude.
    if (currentRegister === 'emma') {
      const locked = "Hi! My name is Emma but that's the name they gave me. Can you help me come up with a better one?";
      delta.ingest('assistant', locked);
      delta.save(DELTA_PATH);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: locked, layer: 'LOCKED', hsl: delta.moodToHSL() }));
      return;
    }
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
    let models = [];
    let ollamaStatus = OLLAMA_URL ? 'unchecked' : 'not-configured';
    if (OLLAMA_URL) {
      try {
        const tags = await fetch(`${OLLAMA_URL}/api/tags`);
        const tagData = await tags.json();
        models = tagData.models?.map(m => m.name) || [];
        ollamaStatus = 'alive';
      } catch {
        ollamaStatus = 'down';
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      ollama: ollamaStatus,
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

  // --- TTS via ElevenLabs ---
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        const apiKey = process.env.ELEVENLABS_API_KEY || config.elevenlabsApiKey;
        if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
        const voiceId = '3470F6oiRpS7SI9iCQLH';
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (!elRes.ok) throw new Error(`ElevenLabs returned ${elRes.status}`);
        const audioBuffer = await elRes.arrayBuffer();
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.byteLength
        });
        res.end(Buffer.from(audioBuffer));
      } catch (err) {
        console.log('[tts] ElevenLabs error:', err.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TTS unavailable' }));
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

  if (req.method === 'GET' && req.url === '/queen') {
    try {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // /em — primary product URL. The mirror.
  if (req.method === 'GET' && req.url === '/em') {
    currentRegister = 'emma';
    try {
      const html = readFileSync(join(__dirname, 'em.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('em.html not found');
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

  // /akasha — pattern report for Nova's dock (read-only, anonymized)
  if (req.method === 'GET' && req.url === '/akasha') {
    const report = buildReport();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ report: report || null, ts: new Date().toISOString() }));
    return;
  }

  // /subscribe — create Stripe Checkout session
  if (req.method === 'POST' && req.url === '/subscribe') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        if (!STRIPE_SECRET) throw new Error('Stripe not configured');
        if (!STRIPE_PRICE_ID) throw new Error('STRIPE_PRICE_ID not set');
        const BASE = process.env.NODE_ENV === 'production' ? 'https://indahl.ai' : `http://localhost:${PORT}`;
        const session = await stripePost('/checkout/sessions', {
          'customer_email': email,
          'mode': 'subscription',
          'line_items[0][price]': STRIPE_PRICE_ID,
          'line_items[0][quantity]': '1',
          'success_url': `${BASE}/em?session_id={CHECKOUT_SESSION_ID}`,
          'cancel_url': `${BASE}/em`,
        });
        if (session.error) throw new Error(session.error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: session.url }));
      } catch (err) {
        console.error('[subscribe]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // /verify — confirm Stripe subscription is active after checkout
  if (req.method === 'POST' && req.url === '/verify') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { session_id } = JSON.parse(body);
        if (!STRIPE_SECRET) throw new Error('Stripe not configured');
        const session = await stripeGet(`/checkout/sessions/${session_id}`);
        if (session.error) throw new Error(session.error.message);
        const active = session.payment_status === 'paid' && !!session.subscription;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active, customer_email: session.customer_details?.email || '' }));
      } catch (err) {
        console.error('[verify]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false }));
      }
    });
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

// Akasha dock — aggregate themes every 6 hours, write current report
if (AKASHA_ENABLED) {
  setInterval(() => {
    try {
      const report = buildReport();
      if (report) {
        writeFileSync(join(__dirname, 'akasha-current.txt'), report);
        writeFileSync(THEMES_PATH, '[]');
        console.log('[akasha] dock:', report);
      }
    } catch (e) { console.log('[akasha] dock error:', e.message); }
  }, 6 * 60 * 60 * 1000);
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
