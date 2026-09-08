# Review and validation

For the later claude-swap integration and current-laptop tests, see
[current journey verification](JOURNEY-VERIFICATION.md).

Reviewed upstream commit `42cba15` (Unsnooze 1.18.0) for the laptop commute and
usage-limit recovery workflow. This is a focused reliability review, not an
exhaustive security audit of every supported agent/backend.

## Findings addressed

1. **No environmental readiness gate.** A due session could be dispatched while
   offline or at low battery. Added optional `battery50` mode, shared between
   preview, limit dispatch and monitored transport recovery. Environmental waits
   preserve the original reset deadline and attempts, and remain visible through
   the last-error field/preview.
2. **The transport retry path ignored the master pause switch.** Added checks
   both before and after its delay, so `autoResume off` also prevents those
   automatic messages.
3. **A pane/agent could disappear during transport backoff.** Recheck pane
   liveness and the recorded lease after waiting, before capturing or typing.
4. **Laptop checks need bounded failure handling.** The battery subprocess has
   a timeout and output limit; the authenticated TLS probe has an overall
   deadline and cleans up its socket on every outcome. Unknown values block
   rather than assuming the laptop is ready. Dependencies are injectable for
   offline tests; no new dependencies or API credentials are required.

The existing session claims, reset parser, busy checks and resume arguments
remain in use. The implementation does not introduce a second session scheduler.

## Evidence

- macOS, Node v25.2.1; dependencies installed from the lockfile with lifecycle
  scripts disabled. Dependency audit reported zero known vulnerabilities at
  installation time.
- Full suite: **1,280 tests, 1,279 passed inside the filesystem/network sandbox**.
  The sole failure was the pre-existing SIGTSTP test: macOS denied its `ps`
  child-process inspection (`operation not permitted`).
- That entire test file passed separately with process inspection allowed:
  **15/15**, including the previously blocked SIGTSTP assertion.
- New readiness/recovery tests: **9/9**, using temporary state and fake battery,
  network, terminal panes and retry timers; no model requests or live resumes.
- Package dry-run and whitespace validation checked before delivery.

## Remaining operational boundaries

See [Laptop mode](LAPTOP-MODE.md) for deployment and physical acceptance testing.
The battery gate does not itself stop active tasks or prevent lid sleep. Those
are Amphetamine/macOS responsibilities. CLI transport recovery requires a
recognized visible error and a surviving monitor; GUI-only network failures
cannot be inferred from Codex rollout files. Provider connectivity can change
between checking and sending, and TLS reachability is not proof of API health.

No live daemon, Amphetamine configuration, shell wrapper or power setting was
modified during this review. No public npm release was made.
