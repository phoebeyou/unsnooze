import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-account-test-'));
process.env.UNSNOOZE_STATE_DIR = join(dir, 'state');
process.env.UNSNOOZE_ACCOUNT_SWITCHER = 'claude-swap';
process.env.UNSNOOZE_ACCOUNT_SWITCHER_DIR = dir;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(dir, 'claude');
const { accountReadiness, readAccountSwitch, usesSharedClaudeAccount } = await import('../src/account-switcher.js');
const { reconcileAccountSwitches, dueForDispatch, dispatchOne } = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');
after(() => rmSync(dir, { recursive: true, force: true }));
const claude = { agent: 'claude' };

test('shared Claude profile only; never accelerate isolated profiles or other agents', () => {
  assert.equal(usesSharedClaudeAccount(claude), true);
  assert.equal(usesSharedClaudeAccount({ ...claude, env: { CLAUDE_CONFIG_DIR: join(homedir(), '.claude') } }), true);
  assert.equal(usesSharedClaudeAccount({ ...claude, env: { CLAUDE_CONFIG_DIR: dir } }), false);
  assert.equal(usesSharedClaudeAccount({ agent: 'codex' }), false);
});

test('switch lock, unavailable metadata, clock skew and 45-second pickup grace all defer', async () => {
  const now = 200000;
  for (const state of [null, { available: false }, { available: true },
    { available: true, changedAt: now + 1 },
    { available: true, changedAt: now - 44999 },
    { available: true, changedAt: 1, switchedAt: now - 30000 }]) {
    assert.equal((await accountReadiness(claude, { now, inspect: async () => state })).ready, false);
  }
  assert.equal((await accountReadiness(claude, { now, inspect: async () => ({ available: true, changedAt: now - 45000 }) })).ready, true);
});

function seed(suffix, detectedAt, resetAt) {
  return Object.values(upsertSession({ sessionId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    agent: 'claude', cwd: dir, pane: '%1', mux: 'tmux', status: 'stopped', detectedAt,
    resetAt, resetSource: 'absolute', attempts: 0 }).sessions).find(s => s.sessionId.endsWith(suffix.padStart(12, '0')));
}

test('confirmed later switch brings a stop forward once; no switch preserves original reset', async () => {
  const now = Date.now();
  const rec = seed('1', now - 120000, now + 3600000);
  await reconcileAccountSwitches({ now, inspect: async () => ({ ready: false }) });
  assert.equal(readState().sessions[rec.key].resetAt, rec.resetAt);
  await reconcileAccountSwitches({ now, inspect: async () => ({ ready: true, switchedAt: now - 180000 }) });
  assert.equal(readState().sessions[rec.key].resetAt, rec.resetAt, 'switch before stop is irrelevant');
  await reconcileAccountSwitches({ now, inspect: async () => ({ ready: true, switchedAt: now - 60000 }) });
  const updated = readState().sessions[rec.key];
  assert.equal(updated.resetAt, now);
  assert.equal(updated.originalResetAt, rec.resetAt);
  assert.equal(updated.attempts, 0);
  assert.ok(dueForDispatch(now).some(s => s.key === rec.key));
  await reconcileAccountSwitches({ now: now + 1000, inspect: async () => ({ ready: true, switchedAt: now - 60000 }) });
  assert.equal(readState().sessions[rec.key].resetAt, now, 'same event never re-arms');
});

test('pause remains authoritative across completed account switches', async () => {
  const now = Date.now();
  const rec = seed('2', now - 120000, now + 3600000);
  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  try {
    await reconcileAccountSwitches({ now, inspect: async () => ({ ready: true, switchedAt: now - 60000 }) });
    assert.equal(readState().sessions[rec.key].resetAt, rec.resetAt);
  } finally { delete process.env.UNSNOOZE_AUTO_RESUME; }
});

test('metadata reader uses POSIX locks, ignores stale lock-file existence, and emits no identities', { skip: process.platform === 'win32' }, async () => {
  for (const name of ['.lock', '.autoswitch_state.lock']) writeFileSync(join(dir, name), '');
  writeFileSync(join(dir, 'sequence.json'), JSON.stringify({ activeAccountNumber: 2,
    accounts: { '2': { email: 'private@example.test' } } }));
  writeFileSync(join(dir, 'autoswitch_state.json'), JSON.stringify({ schemaVersion: 1,
    lastSwitchAt: 100, lastSwitchTo: '2', lastSwitchFrom: 1 }));
  const state = await readAccountSwitch();
  assert.equal(state.available, true);
  assert.equal(state.switchedAt, 100000);
  assert.equal(JSON.stringify(state).includes('private'), false);
  const lock = spawn('python3', ['-c',
    "import fcntl,sys,time; f=open(sys.argv[1],'r'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(10)", join(dir, '.lock')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { lock.stdout.once('data', resolve); lock.once('error', reject); });
    assert.equal((await readAccountSwitch()).available, false);
  } finally { lock.kill(); }
});

// Explicit opt-in: uses the user's installed cswap engine and its real locks /
// atomic state writer, with only the credential mutation replaced by a fake.
// No account inventory, credentials, Keychain or model endpoints are accessed.
test('installed claude-swap completion protocol interoperates with resume gate', {
  skip: !process.env.UNSNOOZE_TEST_CSWAP_PYTHON,
}, async () => {
  const result = spawnSync(process.env.UNSNOOZE_TEST_CSWAP_PYTHON, ['-c', `
import json,sys
from pathlib import Path
from claude_swap.autoswitch import AutoSwitchEngine
from claude_swap.locking import FileLock
from claude_swap.settings import atomic_write_json
root=Path(sys.argv[1])
class FakeSwitcher:
 def switch_to(self, number, json_output):
  with FileLock(root/'.lock'):
   atomic_write_json(root/'sequence.json', {'activeAccountNumber':number,'accounts':{number:{}}})
  return {'switched':True,'from':{'number':1},'to':{'number':2}}
engine=AutoSwitchEngine.__new__(AutoSwitchEngine)
engine.dry_run=False
engine.switcher=FakeSwitcher()
engine.state_path=root/'autoswitch_state.json'
engine.clock=lambda:200.0
engine._emit=lambda event:None
engine._perform('2','synthetic@example.test','at-limit',(0.0,10000.0))
`, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = await readAccountSwitch();
  assert.equal(snapshot.switchedAt, 200000);
  assert.equal(snapshot.available, true);
});

test('two stopped sessions resume independently once after the same switch', async () => {
  const now = Date.now();
  const records = ['201', '202'].map(suffix => {
    const sessionId = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    return Object.values(upsertSession({ sessionId, agent: 'claude', cwd: dir,
      pane: `%${suffix}`, mux: 'tmux', status: 'stopped', detectedAt: now-120000,
      resetAt: now+3600000, resetSource: 'absolute', attempts: 0 }).sessions).find(r => r.sessionId === sessionId);
  });
  await reconcileAccountSwitches({ now, inspect: async () => ({ ready: true, switchedAt: now-60000 }) });
  const sent = [];
  const mux = { paneAlive: async () => true, capturePane: async () => '❯', sendText: async pane => sent.push(pane) };
  for (const original of records) {
    const rec = readState().sessions[original.key];
    assert.equal(rec.resetAt, now);
    assert.equal(await dispatchOne(rec, { mux, readiness: async () => ({ ready: true }), matchesLease: () => true }), 'injected');
    assert.equal(await dispatchOne(rec, { mux, readiness: async () => ({ ready: true }), matchesLease: () => true }), 'stale');
  }
  assert.deepEqual(sent, ['%201','%202']);
});
