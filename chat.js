import readline from 'node:readline';

const SERVER = 'http://localhost:3377';
const history = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// HSL to ANSI approximate color for terminal
function hslToAnsi(hsl) {
  if (!hsl) return '\x1b[0m';
  const { h, s, l } = hsl;
  // Map hue to basic ANSI colors
  if (l < 30) return '\x1b[35m'; // dark = magenta
  if (h < 30) return '\x1b[31m'; // red
  if (h < 60) return '\x1b[33m'; // yellow
  if (h < 150) return '\x1b[32m'; // green
  if (h < 210) return '\x1b[36m'; // cyan
  if (h < 270) return '\x1b[34m'; // blue
  if (h < 330) return '\x1b[35m'; // magenta
  return '\x1b[31m'; // red (wraparound)
}

console.log(`
╔══════════════════════════════════════════╗
║         COMPANION — TERMINAL            ║
║     Type anything. Ctrl+C to quit.      ║
╚══════════════════════════════════════════╝
`);

function ask() {
  rl.question('\x1b[37myou > \x1b[0m', async (input) => {
    if (!input.trim()) { ask(); return; }

    history.push({ role: 'user', content: input });

    try {
      const res = await fetch(`${SERVER}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      const data = await res.json();

      const color = hslToAnsi(data.hsl);
      const layer = data.layer === 'DEPTH' ? ' [deep]' : '';
      console.log(`${color}companion >${layer} ${data.response}\x1b[0m`);

      if (data.hsl) {
        console.log(`\x1b[90m  color: hsl(${data.hsl.h}, ${data.hsl.s}%, ${data.hsl.l}%)\x1b[0m`);
      }

      history.push({ role: 'assistant', content: data.response });

      // Keep history manageable — rolling 20 turns
      if (history.length > 40) {
        history.splice(0, 2);
      }

    } catch (err) {
      console.log(`\x1b[31m[error] ${err.message}\x1b[0m`);
      console.log('\x1b[90mIs the server running? npm start\x1b[0m');
    }

    ask();
  });
}

ask();
