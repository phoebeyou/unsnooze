import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-readiness-'));
process.env.UNSNOOZE_STATE_DIR = dir;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_UPDATE_CHECK = 'off';
process.env.UNSNOOZE_LAPTOP_MODE = 'off';
const { checkResumeReadiness, parseBatteryPercent, readBatteryPercent, providerReachable } = await import('../src/resume-readiness.js');
const { dispatchOne, routeDispatchOutcome, planFor, dueForDispatch } = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');
const { setConfigValue } = await import('../src/settings.js');
after(() => rmSync(dir, { recursive: true, force: true }));
const options = { mode: 'battery50', platform: 'darwin', battery: async () => 75, reachable: async () => true };

test('battery parser accepts actual pmset output and rejects missing or invalid readings', () => {
  assert.equal(parseBatteryPercent("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t51%; discharging; 2:00 remaining present: true"), 51);
  for (const text of ['', 'Power 95%', 'InternalBattery-0 101%;', 'InternalBattery-0 -1%;']) {
    assert.equal(parseBatteryPercent(text), null);
  }
});

test('battery command failures are unknown, never assumed charged', async () => {
  assert.equal(await readBatteryPercent({ run: async () => { throw Error('timeout'); } }), null);
});

test('battery boundary and unknown readings block; 51% resumes', async () => {
  for (const percent of [0, 49, 50, null, NaN, 101, -1]) {
    let probed = false;
    const result = await checkResumeReadiness({ agent: 'codex' }, { ...options,
      battery: async () => percent, reachable: async () => { probed = true; return true; } });
    assert.equal(result.ready, false);
    assert.equal(probed, false);
  }
  assert.equal((await checkResumeReadiness({ agent: 'codex' }, { ...options, battery: async () => 51 })).ready, true);
});

test('offline, unsupported mode/platform/provider and probe errors fail closed', async () => {
  for (const overrides of [{ reachable: async () => false }, { mode: 'typo' }, { platform: 'linux' },
    { reachable: async () => { throw Error('DNS'); } }]) {
    assert.equal((await checkResumeReadiness({ agent: 'codex' }, { ...options, ...overrides })).ready, false);
  }
  assert.equal((await checkResumeReadiness({ agent: 'grok' }, options)).ready, false);
  assert.equal((await checkResumeReadiness({}, { mode: 'off', battery: () => { throw Error('must not call'); } })).ready, true);
});

test('connectivity uses the agent host', async () => {
  for (const [agent, host] of [['codex', 'chatgpt.com'], ['claude', 'api.anthropic.com']]) {
    assert.equal((await checkResumeReadiness({ agent }, { ...options, reachable: async actual => {
      assert.equal(actual, host); return true;
    } })).ready, true);
  }
});

test('TLS probe cleans up on success, certificate failure, network failure, close and deadline', async () => {
  for (const event of ['secureConnect', 'unauthorized', 'error', 'close', 'timeout']) {
    let destroyed = false;
    const result = await providerReachable('example.test', { timeoutMs: 10, dial: opts => {
      assert.equal(opts.rejectUnauthorized, true);
      assert.equal(opts.servername, 'example.test');
      const socket = new EventEmitter();
      socket.authorized = event !== 'unauthorized';
      socket.destroy = () => { destroyed = true; };
      if (event !== 'timeout') queueMicrotask(() => socket.emit(event === 'unauthorized' ? 'secureConnect' : event));
      return socket;
    } });
    assert.equal(result, event === 'secureConnect');
    assert.equal(destroyed, true);
  }
  assert.equal(await providerReachable('example.test', { dial: () => { throw Error('dial'); } }), false);
});

test('laptopMode configuration validates allowed values', () => {
  assert.equal(setConfigValue('laptopMode', 'battery50'), 'battery50');
  assert.throws(() => setConfigValue('laptopMode', 'typo'));
  setConfigValue('laptopMode', 'off');
});

test('due reset waits through outage and low battery, survives reread, then resumes same session once', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000051';
  const resetAt = Date.now() - 1000;
  const state = upsertSession({ sessionId, agent: 'codex', cwd: dir, pane: null,
    mux: 'tmux', status: 'stopped', detectedAt: Date.now() - 3600000,
    resetAt, resetSource: 'absolute', attempts: 0 });
  let rec = Object.values(state.sessions).find(s => s.sessionId === sessionId);
  let launches = 0;
  const mux = { newWindow: async (_session, _cwd, spec) => {
    launches++;
    assert.ok(spec.args.includes(sessionId), 'resume exact saved conversation');
    return { pane: '%51', paneOwner: null };
  } };
  for (let i = 0; i < 12; i++) {
    const readiness = r => checkResumeReadiness(r, { ...options,
      reachable: async () => false, ...(i > 5 ? { battery: async () => 50 } : {}) });
    const plan = await planFor(rec, { mux, readiness });
    assert.equal(plan.action, 'environment-wait');
    const result = await dispatchOne(rec, { mux, readiness });
    assert.equal(result, 'environment-wait');
    assert.deepEqual(routeDispatchOutcome(result, rec, new Map()), { verify: false, waitBusy: false });
    rec = readState().sessions[rec.key];
    assert.equal(rec.status, 'stopped');
    assert.equal(rec.attempts, 0);
    assert.equal(rec.resetAt, resetAt);
    assert.ok(dueForDispatch().some(s => s.key === rec.key));
  }
  assert.equal(launches, 0);
  const readiness = r => checkResumeReadiness(r, options);
  assert.equal(await dispatchOne(rec, { mux, readiness }), 'reopen');
  assert.equal(launches, 1);
  assert.equal(readState().sessions[rec.key].status, 'resuming');
  assert.equal(await dispatchOne(rec, { mux, readiness }), 'stale');
  assert.equal(launches, 1);
});

test('active CLI transport error waits offline, retries on reconnection, respects pause and busy state', async () => {
  const { createMonitor } = await import('../src/monitor.js');
  const { getAgent } = await import('../src/agents/index.js');
  let online = false;
  let paneText = 'stream error: error sending request\n›';
  const messages = [];
  const waits = [];
  const monitor = createMonitor({ pane: '%91', cwd: dir, agent: getAgent('codex'),
    versionSkewed: () => false, notifier: () => {}, spawner: () => {},
    readiness: r => checkResumeReadiness(r, { ...options, reachable: async () => online }),
    waitForRetry: async ms => { waits.push(ms); },
    mux: { paneAlive: async () => true, capturePane: async () => paneText,
      sendText: async (_pane, text) => { messages.push(text); paneText = 'Working (esc to interrupt)'; } },
  });
  for (let i = 0; i < 12; i++) await monitor._tick();
  assert.equal(waits.length, 0, 'offline does not consume retry ladder');
  assert.equal(messages.length, 0);
  online = true;
  await monitor._tick();
  assert.equal(messages.length, 1);
  await monitor._tick();
  assert.equal(messages.length, 1, 'working agent gets no duplicate continue');
  paneText = 'stream error: retrying 4/5\n›';
  await monitor._tick();
  assert.equal(messages.length, 1, 'internal retry is busy');
  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  try {
    paneText = 'stream error: error sending request\n›';
    await monitor._tick();
    assert.equal(messages.length, 1, 'master pause also covers transport retries');
  } finally { delete process.env.UNSNOOZE_AUTO_RESUME; monitor.stop(); }
});
