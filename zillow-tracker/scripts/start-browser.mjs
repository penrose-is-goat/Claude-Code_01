#!/usr/bin/env node
/**
 * Starts your own Chrome with its DevTools port open, so the app can read pages through it.
 *
 *   npm run browser
 *
 * Zillow refuses a headless browser with HTTP 403 — measured, not assumed. It does not
 * refuse the browser you use every day. This starts that browser, normally, with one
 * extra flag that lets a local program attach to it.
 *
 * What attaching does and does not mean: the app opens pages you could open yourself,
 * reads what renders, and closes the tab. It never types, clicks, submits, or reads
 * anything you have not already loaded. The port listens on 127.0.0.1 only, so nothing
 * outside this machine can reach it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CHROME_CDP_PORT ?? 9222);

/** Where Chrome actually lives, per platform, most likely first. */
function findChrome() {
  const candidates = process.platform === 'win32'
    ? [
        join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

  return candidates.find((p) => p && existsSync(p)) ?? null;
}

const chrome = findChrome();
if (!chrome) {
  console.error(
    'Could not find Chrome or Edge in the usual places.\n' +
    'Start it yourself with:  --remote-debugging-port=' + PORT + '\n' +
    'or set CHROME_PATH to the executable and run this again.',
  );
  process.exit(1);
}

// A SEPARATE profile directory. Chrome refuses a debugging port on a profile that is
// already open in another window, and reusing the everyday profile would mean closing
// every existing tab first. This one persists, so a login or a dismissed cookie banner
// is remembered between runs.
const profile = process.env.CHROME_PROFILE_DIR ?? join(homedir(), '.zillow-tracker-chrome');

console.log(`Starting ${chrome}`);
console.log(`  debugging port : 127.0.0.1:${PORT} (this machine only)`);
console.log(`  profile        : ${profile}`);
console.log('\nLeave this window open while you use the app.');
console.log('Browse normally in it — the app reads pages through this browser.\n');

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
], { stdio: 'inherit' });

child.on('exit', (code) => {
  console.log(`\nBrowser closed (exit ${code ?? 0}). The app cannot read pages until you run this again.`);
  process.exit(code ?? 0);
});
