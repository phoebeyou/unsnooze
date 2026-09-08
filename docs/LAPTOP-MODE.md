# Laptop resume mode

This fork adds an opt-in macOS profile for Codex CLI and Claude Code. It waits
for battery **strictly above 50%** and a verified TLS connection to the provider
before resuming a due usage-limit stop or retrying a recognized CLI transport
error. The limit must still reach its reset time; this does not reset or bypass
usage limits.

## Enable after installing this fork

From this checkout:

```sh
npm ci --ignore-scripts
npm install -g . --ignore-scripts
unsnooze config set laptopMode battery50
unsnooze config set autoResume on
unsnooze config set multiplexer tmux
unsnooze config set updateCheck off
unsnooze setup
unsnooze doctor
unsnooze preview
```

Run the setup wizard to install or refresh the background service and shell
wrappers; open a new terminal afterwards. Existing monitor processes must also
be restarted through fresh wrapped CLI sessions to pick up this fork. Do not
run `unsnooze update`: it installs upstream npm releases over your custom build.
Fetch updates into the fork, review, test and reinstall instead.

The profile can also be selected with `UNSNOOZE_LAPTOP_MODE=battery50`. A saved
setting is preferable for the background service, which may not inherit shell
variables. `laptopMode off` restores upstream behavior. `autoResume off` pauses
future automatic limit resumes and transport-error retries; it does not stop
an agent already working. Explicit resume-now still obeys laptop readiness.

## Intended evening workflow

1. Start Codex or Claude through the installed shell wrapper in tmux. Give it a
   concrete task with a clear finish condition.
2. Before leaving, ensure Amphetamine is running and configured as below.
3. Lock the screen. The screen can sleep while the system stays awake.
4. While internet is unavailable, recognized error retries wait. If a usage
   reset passes during the outage, its record remains due without spending
   retries or changing the reset deadline.
5. Once internet is reachable and battery is above 50%, a tracked limit stop is
   eligible on the next resumer poll (normally 30 seconds). Recognized CLI
   transport errors use the existing retry backoff (starting around 30 seconds)
   after the pane monitor notices recovery (normally a 5-second poll).
6. At 50% or less, new resumes/retries wait. Amphetamine must separately end its
   keep-awake session at that threshold so the closed Mac can sleep.

## Amphetamine settings on the work Mac

Configure a **Battery & Power Adapter** trigger whose battery criterion is
above 50%, independent of adapter connection and Wi-Fi availability. Verify the
trigger stops at 50% on your installed version. Do not use a Wi-Fi-only trigger:
letting the system sleep during the commute prevents this local watcher from
noticing Wi-Fi returning.

- Allow display sleep: on.
- Allow system sleep when display is closed: off for this trigger.
- Check other manual/AC triggers: none should keep a closed Mac awake at or below
  50% if that is your desired global cutoff.
- Keep the macOS lock-screen password requirement enabled.
- On Apple Silicon, follow the developer's Power Protect installation if needed
  for reliable closed-display operation across plugging/unplugging the charger.

Amphetamine installation alone does not establish these settings. This change
has not altered Amphetamine, power settings, login items or your live sessions.

Keep the running laptop on a ventilated surface, not in a closed bag. For a
bagged commute, let it sleep and wake it after taking it out; automatic closed-
lid Wi-Fi recovery cannot be promised once macOS has put the system to sleep.

## Boundaries

- The battery gate applies even on AC power. Unknown battery readings, command
  failure, unsupported operating systems and invalid modes fail closed.
- This profile currently supports the normal ChatGPT-authenticated Codex host
  (`chatgpt.com`) and Claude host (`api.anthropic.com`). Custom providers, API-key
  Codex endpoints, VPN proxy requirements and other agents need their own probe
  configuration before this profile can be used for them.
- TLS verifies a route to the expected host, not quota, application health, or
  every streaming endpoint. Connectivity can fail again after a successful
  check; the existing retry logic still applies.
- Network-error recovery requires a live, monitored CLI pane displaying an
  existing recognized transport-error pattern. Arbitrary crashes, hidden GUI
  errors, permission prompts and user cancellations are not auto-resumed.
- GUI usage-limit detection may reopen the conversation in a CLI pane. It does
  not guarantee that the original desktop task continues in its original UI.
- At 50%, this code prevents future resumes; it does not suspend already-running
  processes. Amphetamine/macOS supply the sleep boundary. Native agent retries
  are also outside Unsnooze's control.
- Already sleeping or shut-down Macs cannot run this watcher. Closed-lid
  operation, reconnect behavior and the cutoff require a physical test on the
  target laptop; software simulation cannot prove those hardware behaviors.

## Validation

`node --test test/resume-readiness.test.js` runs offline using fake battery,
network, timers and terminal panes, with a temporary state directory. It tests
50/51%, unknown readings, TLS failure and timeout cleanup, repeated outage polls,
durable state rereads, same-session revival, duplicate dispatch prevention,
recognized CLI transport recovery, internal busy retries and the pause switch.
No model requests, real session resumes or power changes are needed.

After deployment, perform a supervised physical acceptance test on a desk:
start a harmless wrapped task, disconnect Wi-Fi, close the lid with adequate
battery, restore Wi-Fi, then inspect timestamps after reopening. Separately
verify the Amphetamine threshold and charger transitions. Use `unsnooze status`
and `unsnooze preview` to inspect queued limit stops. Do not infer success just
from the keep-awake menu icon.

## Sources

- [Unsnooze upstream](https://github.com/saaranshM/unsnooze)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Amphetamine developer's Power Protect instructions](https://github.com/x74353/Amphetamine-Power-Protect)
- [Amphetamine app description and trigger features](https://apps.apple.com/us/app/amphetamine/id937984704)
