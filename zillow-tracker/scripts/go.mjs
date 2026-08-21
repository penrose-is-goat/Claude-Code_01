#!/usr/bin/env node
/**
 * One command, from a fresh clone to a running app, on any OS.
 *
 *   npm run go
 *
 * This is a Node script rather than a shell script on purpose. The previous version was
 * `bash run.sh`, which is fine on macOS and Linux and simply does not run in PowerShell —
 * so the documented way to start the app failed on Windows. Node is already required to
 * run this project at all, so a Node script is the one interpreter guaranteed present.
 *
 * Every step is idempotent; run it again whenever.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Running npm from Node on Windows.
 *
 * npm is npm.cmd there, and since Node 20.12 / 22 (the fix for CVE-2024-27980) spawning
 * a .cmd file WITHOUT a shell throws EINVAL outright. Spawning it WITH a shell works, and
 * then the bare name `npm` resolves through PATHEXT anyway — so Windows takes the shell
 * path and everything else keeps the safer shell-free path.
 *
 * The cost of a shell is that arguments are re-parsed by cmd.exe, so anything containing
 * a space or a shell metacharacter has to be quoted. `--place "Boulder, CO"` is exactly
 * such an argument, which is why quoting is not optional here.
 */
const isWindows = process.platform === 'win32';
const NPM = 'npm';
const NPX = 'npx';

/** Quotes an argument for cmd.exe when, and only when, it needs it. */
function quoteForShell(arg) {
  if (!isWindows) return arg;
  if (arg.length > 0 && !/[\s"&|<>^()%!,]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

function step(label) {
  console.log(`\n${bold(`==> ${label}`)}`);
}

/** Runs a command, inheriting stdio. Returns the exit code instead of throwing. */
function run(cmd, args, { optional = false } = {}) {
  const result = spawnSync(cmd, isWindows ? args.map(quoteForShell) : args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    // With a shell, cmd.exe has already parsed the arguments; asking Node to escape them
    // again would double-escape the quotes just added above.
    windowsVerbatimArguments: isWindows,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(
        `Could not find "${cmd}".`,
        'Node.js and npm need to be installed and on your PATH.',
        'Install the LTS build from https://nodejs.org, then close and reopen your terminal.',
      );
    }
    fail(`Could not run ${cmd}: ${result.error.message}`);
  }

  if (result.status !== 0 && !optional) {
    fail(`"${cmd} ${args.join(' ')}" failed with exit code ${result.status}.`);
  }
  return result.status ?? 0;
}

function fail(...lines) {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
}

/** Finds a capture file and reads the place out of the file itself. */
function findCapture() {
  const dir = join(root, 'captures');
  if (!existsSync(dir)) return null;

  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const file = join(dir, name);
    try {
      const place = JSON.parse(readFileSync(file, 'utf8')).place;
      if (typeof place === 'string' && place.trim()) return { file, place: place.trim() };
    } catch {
      // A malformed capture is skipped, not fatal.
    }
  }
  return null;
}

step('Installing dependencies');
run(NPM, ['install', '--no-audit', '--no-fund']);

step('Installing the browser');
// Zillow refuses a plain HTTP fetch; a real Chromium is what gets a real page. Optional
// so a download failure leaves the app working through the search-index provider rather
// than refusing to start.
run(NPX, ['playwright', 'install', 'chromium'], { optional: true });

step('Preparing the database');
run(NPX, ['prisma', 'generate']);
mkdirSync(join(root, 'data'), { recursive: true });
run(NPX, ['prisma', 'db', 'push', '--skip-generate']);

step('Loading the captured Zillow data');
// Whatever captures happen to be present, each naming its own place. Nothing here
// names a city: this app has no built-in area, and a start script that hardcodes one
// is a built-in area no matter how it got there.
const capture = findCapture();
if (capture) {
  // Replays real search results captured from Zillow's public pages through the live
  // parser. Optional — a failure here must not stop the app from starting.
  run(NPX, ['tsx', 'scripts/harvest.ts', '--place', capture.place, '--from', capture.file], { optional: true });
} else {
  console.log(dim('  No capture file found; the app will start with an empty database.'));
}

step('Checking it works');
run(NPX, ['vitest', 'run', '--reporter=dot'], { optional: true });

// `--no-start` runs every step except the server, so CI can exercise this whole script
// on a real Windows runner. Without it, the only way to find out that the start path is
// broken on Windows is for someone on Windows to try to start the app.
if (process.argv.includes('--no-start')) {
  console.log(`\n${bold('==> Skipping the server (--no-start)')}`);
  console.log('  Every setup step above completed.');
  process.exit(0);
}

step('Starting the app');
console.log(`
  Open ${bold('http://localhost:3000')}

  The app starts ${bold('empty on purpose')} — no area is built in.
  Type a place or draw an area on the dashboard to search.

  ${capture ? `The bundled capture covers ${bold(capture.place)}.` : 'No data is bundled.'} Searching anywhere else correctly
  returns nothing until you harvest that area:

      npm run harvest -- --place "Your City, ST" --budget 60

  That needs a search key (free tier): ${dim('https://brave.com/search/api')}
  then set BRAVE_SEARCH_API_KEY before running it.

  Press Ctrl+C to stop.
`);
run(NPM, ['run', 'dev']);
