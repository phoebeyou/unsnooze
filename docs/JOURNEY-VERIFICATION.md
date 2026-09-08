# Current laptop journey verification — 2026-09-08

## Observed setup

| Component | Observed |
|---|---|
| macOS | 26.6.2 (25G83), Apple Silicon arm64 |
| Amphetamine | 5.3.2 |
| Claude Code | 2.1.263 |
| claude-swap | 0.26.0, installed with uv |
| tmux | 3.6a |
| Codex CLI | 0.153.4 |
| Test Node | 25.2.1 |
| Battery at inspection | 100%, AC connected |
| claude-swap auto | launchd job loaded; once every 60 seconds; last exit 2 = no action |
| Unsnooze live install | Not found on the command path; custom checkout only |
| Amphetamine trigger | No saved triggers at inspection; user was editing the new-trigger form |
| Power Protect | Standard script and sudoers files not found |

No account credentials were read, copied, printed or switched. No real agent
received a prompt. No Wi-Fi, lid, sleep, battery or live service settings were
changed. The readiness probe did make one certificate-verified TLS connection
to api.anthropic.com, without sending HTTP, credentials or model requests.
It returned **ready** with this laptop's real battery and switch metadata.

## What passed

- **Private tmux journey:** real installed tmux + real Unsnooze monitor/resumer,
  synthetic Claude process, controlled connectivity/battery/clock/switch signals.
  Busy work → offline error for 12 polls → home connectivity → one retry → quota
  stop → wait during account switch → wait through 30 seconds of credential
  pickup → resume at 45 seconds → later reset while offline → hold at 50% →
  resume at 51% → completed work stays completed.
- **Installed claude-swap protocol:** used 0.26.0's actual AutoSwitchEngine
  completion method, advisory locks and atomic metadata writer with fake
  credential mutation and a temporary account inventory. Unsnooze reads the
  resulting confirmed switch correctly. Account selection, provider calls and
  Keychain changes were not performed by this test.
- **Concurrency and policy:** two stopped sessions wake independently once;
  a switch before the stop is ignored; no completed switch retains the original
  reset; the pause switch remains authoritative; isolated profiles are excluded;
  unknown metadata and a held switch lock defer; existing unlocked lock files
  are accepted.
- **Full suite:** 1,288 tests, 1,287 passed in the filesystem/network sandbox.
  The existing process-suspension test could not inspect its child process there.
  Its entire file then passed **15/15** with process inspection allowed.
- **Packaging:** package dry-run includes the read-only Python helper and setup
  guide. No new library dependencies were added.

The tmux integration required permission to create its private local socket,
which the execution sandbox blocks. It remained isolated by a unique socket,
temporary directories and a fake agent, and cleaned up only that private server.
This was not a virtual copy of the whole laptop.

## What cannot be claimed yet

Actual closed-lid awake behavior, home Wi-Fi auto-join, the battery crossing
51% to 50%, macOS Keychain pickup by a live Claude process, and real provider
reset behavior were not physically tested. The 45-second delay is a conservative
integration rule derived from the installed switcher's approximately 30-second
cache guidance; it is not a guarantee of provider authentication success.

The system is not deployed yet. Existing ordinary terminal sessions do not
become monitored simply because the package is installed. At a safe checkpoint,
resume their exact session IDs through the installed wrapper; do not start a
second worker on the same active conversation.

## Supervised acceptance test after deployment

1. Save the battery-at-least-51% Amphetamine trigger described in the setup guide.
   Verify closed-display mode, including Power Protect if the app requests it.
2. Install this fork, enable laptop mode and the claude-swap integration, refresh
   the Unsnooze daemon/wrappers and open a new terminal. Verify `unsnooze doctor`.
3. Start a harmless finite Claude task through the wrapper. Keep the laptop on
   a ventilated desk. Record the time, close the lid, then reopen and confirm
   progress timestamps continued while it was closed.
4. Repeat with a controlled network interruption and reconnection. Confirm a
   recognized error retries once, not while Claude is doing its own retries.
5. Observe a real automatic account switch when one occurs. A busy session may
   continue itself; a tracked quota stop should wait for pickup and resume once.
6. Separately check the battery boundary and charger transitions. At 50% or
   below, no new Unsnooze resumes should occur, and Amphetamine should release
   its keep-awake hold. Other apps or manual triggers can still prevent sleep.

Do not force account exhaustion or drain the battery just to accelerate a test.
Do not run a closed, awake laptop inside a bag. Once the system sleeps, local
software cannot promise to wake itself merely because home Wi-Fi is nearby.
