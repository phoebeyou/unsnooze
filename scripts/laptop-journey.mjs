// Opt-in local integration: real tmux and real Unsnooze monitor/resumer,
// with a fake Claude process, synthetic switch metadata and controlled clock.
// Every tmux command names a private socket. No model/credential/network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-journey-'));
const socket = join(dir, 'tmux.sock');
const events = join(dir, 'events.jsonl');
process.env.UNSNOOZE_STATE_DIR = join(dir, 'state');
process.env.UNSNOOZE_CLAUDE_DIR = join(dir, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(dir, 'codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_UPDATE_CHECK = 'off';
process.env.UNSNOOZE_USAGE_WARN = 'off';
process.env.UNSNOOZE_ACCOUNT_SWITCHER = 'claude-swap';
process.env.UNSNOOZE_ACCOUNT_SWITCHER_DIR = dir;
const { createMonitor } = await import('../src/monitor.js');
const { getAgent } = await import('../src/agents/index.js');
const { accountReadiness } = await import('../src/account-switcher.js');
const { checkResumeReadiness } = await import('../src/resume-readiness.js');
const { dispatchOne, verifyOne, reconcileAccountSwitches, dueForDispatch, routeDispatchOutcome } = await import('../src/resumer.js');
const { readState, upsertSession } = await import('../src/state.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const count = () => { try { return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
let clock = Date.now();
let online = true;
let battery = 80;
const snapshot = { available: true, changedAt: clock - 120000, switchedAt: null };
const account = rec => accountReadiness(rec, { now: clock, inspect: async () => snapshot });
const readiness = rec => checkResumeReadiness(rec, { mode: 'battery50', platform: 'darwin',
  battery: async () => battery, reachable: async () => online, account });
const fake = join(dir, 'fake-claude.mjs');
writeFileSync(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const show=t=>process.stdout.write('\\x1b[2J\\x1b[H'+t+'\\n❯ ');
show('Working (esc to interrupt)');
createInterface({input:process.stdin}).on('line', text=>{
 if(text===':offline') return show('Unable to connect to API. Check your internet connection');
 if(text===':limit') return show("You've hit your session limit · resets in 1 hour");
 if(text===':done') return show('Task complete');
 appendFileSync(${JSON.stringify(events)},JSON.stringify({text})+'\\n');
 show('Working (esc to interrupt)');
});`);
const sendControl = text => { tmux('send-keys', '-t', pane, '-l', text); tmux('send-keys', '-t', pane, 'Enter'); };
let pane;
try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'journey', '-x', '120', '-y', '30', `${quote(process.execPath)} ${quote(fake)}`);
  pane = tmux('display-message', '-p', '-t', 'journey:0', '#{pane_id}');
  await wait(150);
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => tmux('capture-pane', '-p', '-t', pane),
    paneCurrentCommand: async () => tmux('display-message', '-p', '-t', pane, '#{pane_current_command}'),
    sendText: async (_pane, text) => { sendControl(text); await wait(100); },
  };
  const monitor = createMonitor({ pane, cwd: dir, agent: getAgent('claude'), mux,
    readiness, waitForRetry: async () => {}, versionSkewed: () => false,
    notifier: () => {}, spawner: () => {} });
  await monitor._tick(); assert.equal(count(), 0);
  console.log('PASS 17:00 active work: no extra message while busy');
  online = false; sendControl(':offline'); await wait(100);
  for (let i=0;i<12;i++) await monitor._tick();
  assert.equal(count(), 0);
  console.log('PASS commute outage: 12 polls, no retry messages');
  online = true; await monitor._tick(); assert.equal(count(), 1);
  await monitor._tick(); assert.equal(count(), 1);
  console.log('PASS home Wi-Fi: one transport retry; no duplicate while busy');
  sendControl(':limit'); await wait(100);
  const rec = Object.values(upsertSession({ agent: 'claude', sessionId: '00000000-0000-4000-8000-000000000001',
    cwd: dir, pane, mux: 'tmux', status: 'stopped', detectedAt: clock, resetAt: clock+3600000,
    resetSource: 'absolute', attempts: 0 }).sessions)[0];
  // Both accounts exhausted: keep original reset, including a daemon reread.
  await reconcileAccountSwitches({ now: clock, inspect: account });
  assert.equal(dueForDispatch(clock).length, 0);
  console.log('PASS no completed switch: retain original reset deadline');
  clock += 60000; snapshot.available = false;
  await reconcileAccountSwitches({ now: clock, inspect: account });
  assert.equal(dueForDispatch(clock).length, 0);
  snapshot.available = true; snapshot.changedAt = clock; snapshot.switchedAt = clock;
  clock += 30000; await reconcileAccountSwitches({ now: clock, inspect: account });
  assert.equal(dueForDispatch(clock).length, 0);
  console.log('PASS switch in progress and 30-second credential pickup: hold');
  clock += 15000; await reconcileAccountSwitches({ now: clock, inspect: account });
  let due = dueForDispatch(clock); assert.equal(due.length, 1);
  assert.equal(await dispatchOne(due[0], { mux, readiness, matchesLease: () => true }), 'injected');
  assert.equal(count(), 2);
  await verifyOne(rec.key, { resolveMux: () => mux });
  assert.equal(readState().sessions[rec.key].status, 'resumed');
  console.log('PASS settled account switch: one resume before old account reset');
  sendControl(':limit'); await wait(100);
  clock += 60000;
  const next = Object.values(upsertSession({ ...rec, detectedAt: clock, bannerAt: clock,
    status: 'stopped', resetAt: clock + 10000, attempts: 0 }).sessions)[0];
  clock += 11000; online = false;
  const result = await dispatchOne(next, { mux, readiness, matchesLease: () => true });
  assert.equal(result, 'environment-wait'); routeDispatchOutcome(result, next, new Map());
  assert.equal(readState().sessions[next.key].attempts, 0);
  online = true; battery = 50;
  assert.equal(await dispatchOne(next, { mux, readiness }), 'environment-wait');
  assert.equal(count(), 2);
  battery = 51;
  assert.equal(await dispatchOne(next, { mux, readiness, matchesLease: () => true }), 'injected');
  assert.equal(count(), 3);
  await verifyOne(next.key, { resolveMux: () => mux });
  console.log('PASS reset during outage; battery 50% holds, 51% resumes same pane once');
  sendControl(':done'); await wait(100); await monitor._tick();
  assert.equal(count(), 3);
  monitor.stop();
  console.log('PASS completed task stays completed');
  console.log('Hardware lid/sleep/Wi-Fi association and real provider quota were simulated, not physically tested.');
} finally {
  try { tmux('kill-server'); } catch { /* private server failed to start */ }
  rmSync(dir, { recursive: true, force: true });
}
