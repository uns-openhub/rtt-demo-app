# HRM Reference Roadmap

- [x] Rework warehouse quality checks to use measured runtime state instead of recipe-only approximations.
  Capture stage-exit measurements on the batch, keep them in memory for deterministic testing, and inspect against quality specs from those measured values.
- [x] Add read-side assistant patterns for HRM.
  Expose the published model cleanly through `uns-api-global`, then add seeded assistant/eval scenarios in `uns-datahub-controller` against realistic QuestDB history.
- [x] Add a stronger production troubleshooting model.
  Introduce alarm/event examples and keep the split between live state, active lifecycle, and history explicit so UI liveliness and analytics stay coherent.

## RAG-assisted anomaly response demo

Goal: provide one deterministic end-to-end example in which `rtt-demo-app`
simulates an abnormal machine condition, the existing UNS model emits correlated
telemetry and an alarm, Agent - Aljoša detects the live condition, and `uns-rag`
returns scoped operating instructions as cited evidence for an advisory response.

### 1. Furnace operating and recovery guide

- [ ] Add `docs/rag/furnace-zone-overtemperature.md` as the first RAG source
  document. Describe normal furnace-zone operation, the
  `FURNACE_ZONE_OVERTEMP` alarm, relevant UNS paths, expected signal
  correlations, diagnostic checks, demo recovery, and post-recovery
  verification.
- [ ] Keep claims aligned with the simulator's published evidence: zone
  temperature, setpoint/threshold, burner load, exhaust oxygen, alarm state,
  event time, and aggregate identity. Mark generated guidance as advisory and
  require verification against current values and alarm state before action.
- [ ] Document the controller-owned `local-folder` RAG source setup in the main
  README. Point it at `docs/rag`, include only `**/*.md`, use aggregate scope
  `forge-group/novasteel/hot-rolling/hrm-pusher-furnace`, and use
  `contentAccess: "preview-allowed"` for this public demo content. Do not imply
  that Markdown front matter configures source scope or access policy.

### 2. Bounded fault-injection API

- [ ] Add an explicitly enabled, demo-only `hrm.faultInjection` configuration
  section. Keep it disabled by default, validate bounded durations and furnace
  zone identifiers, and regenerate configuration types/schema after changing
  the config contract.
- [ ] Add an authenticated service API under
  `system/hrm/service/{processName}/faults` for listing active faults and
  activating the initial `furnace-zone-overtemperature` scenario. Return a
  stable fault id, scenario, target, activation time, remaining duration, and
  state. Add a separate POST clear action so recovery can be demonstrated
  before automatic expiry.
- [ ] Require an active furnace batch for the initial scenario and reject
  disabled, malformed, conflicting, or out-of-range requests without changing
  simulator state.
- [ ] Inject the fault into furnace physics/state rather than publishing a fake
  alarm directly. The abnormal zone temperature must cross the existing
  threshold so the current alarm logic emits `ACTIVE`; clearing or expiry must
  remove the effect and allow the same logic to emit `CLEARED` after the
  measured value recovers.
- [ ] Keep fault state visible in the simulator status API for deterministic
  demos and troubleshooting, without adding fault-control details to normal
  production telemetry topics.

### 3. Verification of the evidence chain

- [ ] Add focused tests for config gating, API validation, deterministic fault
  activation, correlated furnace telemetry, exactly one `ACTIVE` transition,
  recovery, and exactly one `CLEARED` transition.
- [ ] Run a local end-to-end scenario: submit a batch, wait until it occupies
  the furnace, activate the zone fault, observe the temperature and alarm
  lifecycle in UNS history, clear the fault, and verify recovery.
- [ ] Configure and run the controller-owned RAG ingest job, then query
  `uns-rag` in `evidence-only` mode with the furnace aggregate scope. Verify
  that the response cites the operating guide and preserves document
  provenance and query audit data.
- [ ] Run `pnpm run verify` in each repository changed by the implementation.

### 4. Agent - Aljoša handoff

- [ ] Keep live anomaly detection outside `uns-rag`: the agent must obtain the
  active alarm and current values from controller/QuestDB APIs, because the RAG
  MVP does not yet provide live values, alarms, events, or trend context.
- [ ] Have the agent call RAG only after identifying the alarm code, affected
  zone, aggregate scope, and relevant current values. Use `evidence-only` so
  the agent owns final synthesis while RAG supplies scoped document evidence.
- [ ] Require the final agent response to separate observed live facts,
  document-backed instructions, and inference. It may recommend the demo clear
  action, but must not execute machine or simulator control actions without a
  separate explicit authorization path.

### Acceptance criteria

- [ ] A user can trigger one bounded furnace anomaly through the authenticated
  demo API and observe physically correlated telemetry plus an `ACTIVE` alarm.
- [ ] Agent - Aljoša can detect the live alarm, retrieve the matching guide
  from `uns-rag`, cite it, and explain the safe demo recovery without treating
  the RAG response as live state.
- [ ] Clearing or expiry returns the simulator to normal behavior and produces
  a verifiable `CLEARED` alarm transition.
- [ ] No production endpoint, autonomous control capability, private document,
  credential, local `config.json`, or controller runtime state is committed as
  part of the demo.
