// Readiness gates do not change the reset deadline or spend a resume attempt.
// Used for due quota stops and terminal transport retries; no model requests.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:tls';
import { getConfig } from './settings.js';
import { accountReadiness } from './account-switcher.js';

const runFile = promisify(execFile);
const PROVIDER_HOSTS = Object.freeze({
  codex: 'chatgpt.com', claude: 'api.anthropic.com',
});

export function parseBatteryPercent(output) {
  // Require the actual internal battery line, not a percentage elsewhere.
  const match = String(output).match(/InternalBattery[^\n]*?\s(\d{1,3})%;/);
  if (!match) return null;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : null;
}

export async function readBatteryPercent({ run = runFile } = {}) {
  try {
    const { stdout } = await run('/usr/bin/pmset', ['-g', 'batt'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024,
    });
    return parseBatteryPercent(stdout);
  } catch { return null; }
}

// A verified TLS connection checks DNS, routing and certificate identity.
// A hard deadline includes DNS and handshake time (socket inactivity alone
// does not). No HTTP request, auth token, or model traffic is sent.
export function providerReachable(host, { dial = connect, timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    let socket;
    let settled = false;
    const finish = ready => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = dial({ host, port: 443, servername: host, rejectUnauthorized: true });
      socket.once('secureConnect', () => finish(socket.authorized === true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch { finish(false); }
  });
}

export async function checkResumeReadiness(rec, {
  mode = getConfig('laptopMode'), platform = process.platform,
  battery = readBatteryPercent, reachable = providerReachable,
  account = accountReadiness,
} = {}) {
  const switched = await account(rec);
  if (!switched.ready) return { ready: false, reason: `waiting: ${switched.reason}` };
  if (mode === 'off') return { ready: true };
  const wait = reason => ({ ready: false, reason: `waiting: ${reason}` });
  if (mode !== 'battery50') return wait('invalid laptopMode; use off or battery50');
  if (platform !== 'darwin') return wait('battery50 requires macOS');
  try {
    const percent = await battery();
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return wait('battery level unavailable');
    }
    // Strictly greater than 50%, including while charging, as requested.
    if (percent <= 50) return wait(`battery ${percent}% (must be above 50%)`);
    const host = PROVIDER_HOSTS[rec.agent];
    if (!host) return wait('battery50 supports Codex and Claude only');
    if (!await reachable(host)) return wait(`cannot reach ${host}; retrying on the next poll`);
    return { ready: true };
  } catch { return wait('readiness check unavailable'); }
}
