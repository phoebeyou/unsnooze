// Opt-in, read-only integration with claude-swap 0.26.0's default profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './settings.js';

const runFile = promisify(execFile);
export const ACCOUNT_SETTLE_MS = 45_000;

export function usesSharedClaudeAccount(rec) {
  if (rec.agent !== 'claude') return false;
  // cswap session profiles have separate credentials. A global switch says
  // nothing about them and must never bring their limit deadline forward.
  const home = rec.env?.CLAUDE_CONFIG_DIR;
  return (!home || resolve(home) === join(homedir(), '.claude'))
    && !rec.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR;
}

export async function readAccountSwitch({ run = runFile } = {}) {
  try {
    const { stdout } = await run(getConfig('accountSwitcherPython'), [
      fileURLToPath(new URL('./cswap-status.py', import.meta.url)),
      getConfig('accountSwitcherDir') || join(homedir(), '.claude-swap-backup'),
    ], { timeout: 3000, maxBuffer: 16 * 1024, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch { return { available: false, reason: 'account-switch check unavailable' }; }
}

export async function accountReadiness(rec, {
  mode = getConfig('accountSwitcher'), inspect = readAccountSwitch, now = Date.now(),
} = {}) {
  if (mode === 'off' || !usesSharedClaudeAccount(rec)) return { ready: true };
  if (mode !== 'claude-swap') return { ready: false, reason: 'invalid accountSwitcher setting' };
  const state = await inspect();
  if (!state?.available) return { ready: false, reason: state?.reason || 'account-switch check unavailable' };
  if (!Number.isFinite(state.changedAt) || state.changedAt > now
      || now - state.changedAt < ACCOUNT_SETTLE_MS
      || (state.switchedAt != null && (!Number.isFinite(state.switchedAt)
        || state.switchedAt > now || now - state.switchedAt < ACCOUNT_SETTLE_MS))) {
    return { ready: false, reason: 'waiting 45 seconds for Claude to pick up the account' };
  }
  return { ready: true, switchedAt: state.switchedAt };
}
