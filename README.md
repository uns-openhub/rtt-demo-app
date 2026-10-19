# rtt-demo-app — Hot Rolling Mill Simulator

A configurable industrial IoT simulator for a Hot Rolling Mill (HRM) production line, built on `@uns-kit`. Simulates material flowing through **Pusher Reheating Furnace → Descaling → Rolling Stand → Warehouse/Quality Lab**, driven by recipes and submitted batches. Telemetry is published to MQTT. Batches are submitted and queried via a REST API.

Requires **Node.js 22+** and **pnpm**.

This repository is public source software licensed under the [MIT License](LICENSE).

## Prerequisites

- A running UNS instance (MQTT broker + controller) at `localhost`
- A local `config.json` copied from a tracked example
- A development machine token in an untracked local `.env` when running the
  simulator directly on the host

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Prepare local host-development configuration
cp config-development-host.json config.json
cp .env.example .env

# Build
pnpm run build

# Start (production)
pnpm run start

# Start (dev — auto-restarts on file changes)
pnpm run dev
```

On startup you should see:

```
rtt-demo-app-rttDemoApi - Registered new api endpoint: /system/hrm/service/rtt-demo-app/status
rtt-demo-app-rttDemoApi - Registered new api endpoint: /system/hrm/service/rtt-demo-app/config
rtt-demo-app-rttDemoApi - Registered new api endpoint: /system/hrm/service/rtt-demo-app/batch
rtt-demo-app-rttDemoApi - Registered new api endpoint: /system/hrm/service/rtt-demo-app/recipe-map
rtt-demo-app-rttDemoApi - Registered new api endpoint: /system/hrm/service/rtt-demo-app/recipe
HRM simulator started — system topic: system/hrm/service/rtt-demo-app/# — data: forge-group/novasteel/hot-rolling/ — tick: 2000ms
```

---

## Configuration

The committed runtime profiles deliberately contain no credentials, customer
hosts, or local controller identity. Copy the one that matches where the
process runs, then adapt only the untracked `config.json` if needed:

| Profile | Use it when | MQTT | Credential source |
|---|---|---|---|
| `config-development-host.json` | Running `pnpm run dev` directly on the host | `localhost` | `.env` → `UNS_SERVICE_TOKEN` |
| `config-development-podman.json` | Deploying through a local Podman OpenHub controller | `mosquitto` | Controller-managed `UNS_SERVICE_TOKEN_FILE` |
| `config-production.json` | Creating a production controller instance | `mosquitto` | Controller-managed token file or approved secret provider |

For direct development, `.env.example` also shows the required
`UNS_CONTROLLER_NAME` and `UNS_CONTROLLER_PUBLIC_BASE` values so the service
can publish route metadata. Controller-managed PM2 instances receive them
automatically.

The `hrm` section controls the simulator:

| Field | Default | Description |
|---|---|---|
| `topicBase` | `forge-group/novasteel/hot-rolling/` | MQTT topic prefix for telemetry data |
| `tickIntervalMs` | `2000` | Simulation tick rate in ms |
| `simulationStartTime` | unset | Optional simulated process start timestamp used for published event time; when unset, published timestamps use the realtime system clock |
| `simulationSpeed` | `1` | Process-time acceleration factor per wall-clock tick |
| `simulationResolution` | `100` | Percentage of ticks that emit telemetry (`100` = every tick, `10` = every 10th tick) |
| `productionLine` | — | Asset IDs and physical limits per station (`queue` is optional and defaults to `hrm-queue`) |
| `recipes[]` | — | Rolling recipes (material, thickness, passes) |
| `qualitySpecs[]` | — | Lab quality standards (independent of recipe) |

When `simulationStartTime` is omitted, published MQTT and status/API timestamps follow realtime wall clock. When `simulationStartTime` is set, timestamps follow simulated process time from that anchor. `simulationSpeed` changes how fast physics and station progress advance per wall-clock tick; recipe values remain in normal process units.

The development profiles use a 1s tick, 30x process speed, and full telemetry.
Tune those values only in your untracked `config.json`; production deployments
normally use an instance-specific controller configuration.

## Optional reviewed execution contract

From demo 6.1.19 with compatible Controller/UI 2.2.4, an instance can opt in to
a reviewed State/Action contract, durable adoption receipts and explicit recovery
or closure. Existing profiles keep this disabled. See the
[technical configuration and recovery guide](docs/reviewed-lifecycle-runtime.md)
for trusted file/digest provisioning, permissions and journal limits. This is a
simulator feature, not physical-device or fleet control.

## Release

`package.json` is the version source for this public OpenHub add-on. CI
validates source changes. After a versioned merge, `tag-from-package.yml` creates
the matching `vX.Y.Z` tag and GitHub Release; do not create or move it manually.
The controller's public catalog in `releases` mode intentionally reads GitHub
Releases rather than bare tags.

The demo namespace is fictional: `forge-group` is the group and `novasteel` the company. No real company or site is represented by the published topics.

Raw simulator MQTT payloads now also carry an explicit `dataGroup` per asset, for example `hrm_pusher_furnace`, `hrm_descaling`, `hrm_stand_1`, and `hrm_warehouse`, so QuestDB can keep asset-level raw data separated instead of growing one mixed table.

---

## API Endpoints

All control endpoints live under `system/hrm/service/{processName}/`:

| Method | Path | Description |
|---|---|---|
| `POST` | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/batch` | Submit a new batch |
| `GET`  | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/status` | Full production line state |
| `GET`  | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/config` | Runtime simulator timing config |
| `GET`  | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/batch?batchId=:id` | Single batch detail + quality result |
| `GET`  | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/recipe-map` | Full recipe map |
| `GET`  | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/recipe?recipeId=:id` | Single recipe detail |
| `POST` | `http://localhost:3200/api/system/hrm/service/rtt-demo-app/recipe?recipeId=:id` | Update furnace recipe values in memory |

All requests require `Authorization: Bearer <token>` — see Authentication below.

---

## Authentication

All API endpoints require a Bearer JWT token. Direct development uses the
machine token from `.env`; controller-managed instances read the mounted token
file. The `hrm:submit` and `hrm:watch` scripts use that token automatically and
only prompt for email/password when no machine token has been configured.

```bash
TOKEN="$UNS_SERVICE_TOKEN"
```

Then pass it as a header on every request:

```bash
-H "Authorization: Bearer $TOKEN"
```

Never add a token, email, or password to a committed profile. Operators can use
their own short-lived login token instead of a development machine token for
manual API calls.

---

## Running a Batch

### Using the built-in scripts (recommended)

```bash
# Terminal 1 — start the simulator
pnpm run dev

# Terminal 2 — submit a batch (uses service token, or prompts when absent)
pnpm run hrm:submit

# Terminal 3 — live dashboard
pnpm run hrm:watch
```

Both scripts read the controller URL from `config.json`. A configured service
token is read for every request, so a mounted, rotated token is picked up
without restarting the script. Without one, password input is masked and the
user session is refreshed automatically.

---

### Using curl manually

> The simulator API is proxied through the local UNS controller at
> `localhost:3200`, so you don't need to know the dynamic port.

### 1. Get a token

```bash
TOKEN="$UNS_SERVICE_TOKEN"
```

### 2. Submit a batch

```bash
curl -s -X POST http://localhost:3200/api/system/hrm/service/rtt-demo-app/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "recipeId": "s355-20mm", "materialId": "slab-001", "quantity": 1 }'
```

Response (accepted):

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "recipeId": "s355-20mm",
  "materialId": "slab-001",
  "quantity": 1,
  "status": "accepted",
  "submittedAt": "2026-04-02T08:00:00.000Z"
}
```

### 3. Watch the production line

```bash
curl -s http://localhost:3200/api/system/hrm/service/rtt-demo-app/status \
  -H "Authorization: Bearer $TOKEN" | jq .
```

The batch advances automatically every 2 seconds:
`QUEUED → FURNACE → DESCALING → ROLLING → WAREHOUSE → DONE/FAILED`

### 4. Fetch final quality result

```bash
curl -s "http://localhost:3200/api/system/hrm/service/rtt-demo-app/batch?batchId=550e8400-..." \
  -H "Authorization: Bearer $TOKEN" | jq .warehouse
```

### 5. Inspect and update a recipe online

```bash
curl -s http://localhost:3200/api/system/hrm/service/rtt-demo-app/recipe-map \
  -H "Authorization: Bearer $TOKEN" | jq .
```

```bash
curl -s -X POST "http://localhost:3200/api/system/hrm/service/rtt-demo-app/recipe?recipeId=s355-20mm" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "furnace": { "pusherPaceMin": 18, "targetTempC": 1185, "zones": [ { "zoneId": 1, "setpointC": 920 }, { "zoneId": 2, "setpointC": 1110 }, { "zoneId": 3, "setpointC": 1190 }, { "zoneId": 4, "setpointC": 1180 } ] } }' | jq .
```

---

## Production Line Stages

### Pusher Reheating Furnace
- 4-zone potisna peč / reheating furnace, each zone has an independent setpoint
- Zone temperatures now use a first-order thermal response with PLC-style hunt around setpoint
- Material temperature rises with a first-order heating model toward the recipe target
- Each zone also exposes burner-oriented OT signals such as stoichiometric ratio, exhaust oxygen and burner utilization
- Furnace transport and media signals are exposed separately (`pusher`, `natural-gas`, `combustion-air`)
- Furnace counters include `gas-meter/natural-gas/consumption` for the cumulative natural-gas meter and `equipment/pusher-counter/output-quantity` for total pusher moves; both publish `presentationKind: "counter"` metadata
- `gas-meter/natural-gas/consumption-rate` publishes the current fuel-gas flow while keeping the gas meter identity explicit
- Sub-states: `HEATING → SOAKING → DONE`
- Zone overtemperature alarms publish as `alarm` lifecycle states with matching alarm history rows (`ACTIVE → CLEARED`)
- MQTT topics: `forge-group/novasteel/hot-rolling/hrm-pusher-furnace/equipment/zone-{1..4}/temperature` etc.

### Hydraulic Descaling
- Fixed 30-second water-blast pass (15 ticks)
- Pressure and flow use a simple hydraulic lag instead of jumping instantly
- OT-facing signals are split across `equipment/pump-1`, `equipment/spray-header`, `fluid-resource/water`, and `fluid-resource/hydraulic-oil`
- Water resource topics focus on consumable aspects such as temperature and consumption; pressure remains on pump/header equipment
- The simulator also publishes a live sub-asset under the descaling aggregate:
  `forge-group/novasteel/hot-rolling/hrm-descaling/pump-skid-1/equipment/main/{pressure,flow,speed,current,temperature}`
- MQTT topics: `forge-group/novasteel/hot-rolling/hrm-descaling/equipment/pump-1/pressure`, `.../fluid-resource/water/total-flow` etc.

### Reversing Rolling Stand
- 5-pass rolling plan (S355 recipe: 200 mm → 120 → 80 → 50 → 30 → 20 mm)
- Direction alternates forward/reverse per pass
- Drive speed now follows a simple second-order actuator response instead of an instant setpoint jump
- Stand telemetry includes speed, force, torque, motor current, hydraulic pressure, lubrication flow, bearing temperature, vibration and roll gap
- Pass completion remains available as an event, but it is now published under stand equipment telemetry rather than `process-segment`
- MQTT topics: `forge-group/novasteel/hot-rolling/hrm-stand-1/equipment/stand-1/speed` etc.

### Warehouse / Quality Lab
- Final thickness is measured from the actual rolling end-state with small metrology noise
- Exit temperature is derived from the measured furnace/descaling/rolling path, not directly from recipe targets
- Hardness (HB) is estimated from the measured exit temperature deviation
- Surface grade stochastically assigned (biased toward "A" if temps are on target)
- Quality result compared against **quality spec** (not recipe tolerances)
- Inspection results include explicit internal fail reasons for testing and API status output
- Quality facts are published once when the inspection is created, not as repeating live telemetry
- A one-shot inspection summary event is also published so QuestDB queries can read pass/fail, measured values, and fail reasons from a single history row
- MQTT topic: `forge-group/novasteel/hot-rolling/hrm-warehouse/material/slab-001-3/pass-fail` etc.

---

## UNS Modeling In This Simulator

- Validity metadata exists primarily to drive UI liveliness/activity indicators.
- `interval` means the value should keep updating; if it stops, it becomes stale.
- `lifecycle` means the state is active until an explicit end event/value is published.
- Use `interval` for continuously refreshed telemetry and live state.
- Use `lifecycle` for event-driven activity that starts on one event/value and ends on another.
- One-time facts or historical records should not carry liveliness semantics unless there is a real active-until-ended lifecycle.
- In this app, warehouse quality facts and terminal material outcomes are published without validity metadata; they are queryable facts/history, not active UI states.
- Material object IDs are process-location identities derived from the business `materialId`: the first process identity stays `slab-001`, the next location is `slab-001-1`, then `slab-001-2`, and so on.
- The `previous-material` attribute carries `relationship-evidence` metadata for `material-renumbering`, so a controller can materialize edges such as `slab-001 -> slab-001-1 -> slab-001-2`.
- A merge publishes one `previous-materials` Data packet with the complete,
  deduplicated predecessor list encoded as a JSON string. UNS Kit Data wire
  validation accepts scalar strings/numbers, so this is intentionally not a
  native array. The controller needs the reviewed `previous-materials`
  relationship definition with `sourceObjectIdFrom: "value[]"` and list-decoding
  support. Single transitions keep the existing `previous-material` scalar
  contract. Links remain suggested unless their schema/review policy says
  otherwise; publishing evidence does not approve lineage.
- Upgrade existing installations by reviewing and installing the new
  `previous-materials`, `thickness`, and `rolling-pass` definitions. Do not
  overwrite a package-owned `previous-material` definition. An older controller
  without explicit list decoding is not a supported merge materializer for
  this publisher; update controller/schema before switching the simulator.
- `equipment/stand-1/thickness` and warehouse material `thickness` are numeric
  gauges in mm (`defaultAggregation: "last"`). `rolling-pass` contains completed
  pass Table records; `inspection-result` contains laboratory Table records.
  The pusher `output-quantity` counter is unchanged. Existing archived
  `output-quantity`/`inspection-result` scalar readings remain historical data;
  consumers should prefer the new thickness topics and fall back explicitly.
- Warehouse `EXITED` location records retain the warehouse entry time and
  `WAREHOUSE` stage. Only then does the runtime batch become `DONE`/`FAILED`,
  preserving the actual visit interval for archived traces.
- API/status payloads still expose the business `materialId` (`slab-001`) so external submit/query workflows do not need to know the UNS stage suffix.
- A `materialId` identifies one material and must remain unique within retained demo history. Since 6.1.24, the instance journal retains material identities across restarts; keep using fresh material IDs for new production. Earlier releases do not have this durable journal.
- `dataGroup` is storage/table routing metadata. In this demo it separates raw data by aggregate asset (`hrm_pusher_furnace`, `hrm_descaling`, `hrm_stand_1`, `hrm_warehouse`) and by dynamic sibling groups such as `batch` and `pass`; it is not used to model sub-asset hierarchy.
- Sub-assets should be modeled by putting the full parent asset path in `topic`
  and the leaf sub-asset name in `asset`. For example, a separate service that
  owns a descaling pump skid under `hrm-descaling` would publish:

  ```ts
  await mqttOutput.publishMqttMessage({
    topic: "forge-group/novasteel/hot-rolling/hrm-descaling/",
    asset: "pump-skid-1",
    objectType: "equipment",
    objectId: "main",
    attributes: {
      attribute: "temperature",
      data: {
        time: new Date().toISOString(),
        value: 42,
        uom: "degC",
      },
    },
  });
  ```

  This creates
  `forge-group/novasteel/hot-rolling/hrm-descaling/pump-skid-1/equipment/main/temperature`.
  QuestDB keeps the existing identity columns with
  `topic = "forge-group/novasteel/hot-rolling/hrm-descaling"` and `asset = "pump-skid-1"`;
  do not encode the parent asset in `dataGroup`.
  The live simulator publishes this shape continuously for the descaling
  `pump-skid-1` sub-asset. The repo also includes a one-shot example for
  isolated contract checks:

  ```bash
  pnpm run subasset:example -- --dry-run
  ```

  Remove `--dry-run` only when you intentionally want to publish one sample
  under the local UNS/QuestDB stack.
- Live OT telemetry is modeled primarily under `equipment` and `fluid-resource` so it resembles PLC/L1-acquirable signals rather than MES/post-processing abstractions.
- Material `location` history rows include `stage`, `assetId`, `assetName`, `materialId`, `recipeId`, and duration, so assistant/QuestDB queries do not need to infer stage semantics from topic paths alone.
- Each aggregate also publishes its current loaded material under `material/main`, for example `hrm-pusher-furnace/material/main/lot-id`, `hrm-pusher-furnace/material/main/batch-number`, and `hrm-pusher-furnace/material/main/status`. These `main` occupancy facts are not assigned to the aggregate `dataGroup`; for the multi-slot furnace, `main` means the current lead material and slot occupancy remains available in furnace pusher telemetry.
- Alarm lifecycles use `lifecycle` validity with explicit `ACTIVE` / `CLEARED` transitions, and the simulator also writes alarm history rows so the same condition is usable for both UI liveliness and historical troubleshooting.

---

## Available Recipes

| ID | Material | Target thickness | Passes |
|---|---|---|---|
| `s355-20mm` | S355 structural steel | 20 mm | 5 (200 → 20 mm) |

Add more recipes to the `hrm.recipes` array in `config.json`.

---

## Controller Tree

After startup the UNS controller will show:

```
system
  └── hrm
        └── service
              └── rtt-demo-app
                    ├── status
                    └── batch
```

MQTT telemetry appears under `forge-group/novasteel/hot-rolling/` as soon as a batch is submitted to the queue.

---

## Scripts

```bash
pnpm run dev          # development mode (auto-restart)
pnpm run build        # compile TypeScript → dist/
pnpm run start        # run compiled dist/index.js

pnpm run hrm:submit   # interactive prompt → submit a batch to the production line
pnpm run hrm:watch    # live dashboard — refreshes every 2s
```


## Optional identity-aware furnace Catalog offer

With `hrm.productionLine.furnace.identity` explicitly configured and its provider
association reviewed/resolved by the controller before startup, the demo
registers a **Furnace zone 1 temperature** offer through the normal Data Catalog
API. Its `metadata.assetIdentity` contains the stable Asset ID and relative
Attribute `equipment/zone-1/temperature`, so an identity-aware Catalog can follow
verified location changes without changing the offer ID. The existing production
status GET operation remains available through the configured API base path.

Unconfigured, unresolved or provider-only identity evidence does not register
this offer. If an association is reviewed after startup, restart the demo to
register it. Identity-aware history also needs compatible controller/API readers
and an archiver configured to persist identity enrichment. The offer metadata
contains no identity proof or telemetry topic path. Stopping the demo disables
its live business API; archived values can remain accessible independently.

## Movable roll cassette and work rolls

The standard profiles now include `hrm.productionLine.rollingStand.mobileCassette`.
Existing custom configurations without this optional section keep their previous
station behavior. The cassette starts in the rolling stand; an operator can move
it to the roll store or roll workshop and return it without restarting the demo.
This is a manual equipment-change scenario; it does not automatically shuttle
equipment during production.

The cassette is an Asset. Its upper and lower work rolls are separate subassets,
each with its own external identifier and controller-issued publication evidence:

```text
forge-group/novasteel/hot-rolling/
  hrm-stand-1/                  (or hrm-roll-store / hrm-roll-workshop)
    roll-cassette-001/
      equipment/main/{temperature,vibration,duration,status}
      upper-work-roll-001/equipment/main/{temperature,vibration,duration,status,speed,diameter,wear}
      lower-work-roll-001/equipment/main/{temperature,vibration,duration,status,speed,diameter,wear}
```

Housing/roll temperature, vibration and operating time follow rolling activity.
Roll speed is derived from line speed and diameter. Illustrative wear increases
with operating time; it is not an engineering wear prediction. Off-stand equipment
cools toward ambient temperature and stops rotating. Moving never resets its
external IDs, operating time, diameter or wear. Earlier releases reset this in-memory equipment model on restart. Version 6.1.24
restores its run ID, readings and location from the same instance journal. The workshop does not yet
simulate regrinding or replacement of an individual roll.

Status GET includes `mobileCassette`. The authenticated service API accepts POST
`roll-cassette` with `{location, expectedRevision, expectedRunId}` from that status.
`location` is exactly `stand`, `store` or `workshop`; arbitrary destination paths
and extra request fields are rejected. Occupied stands, stale state and prior-run
commands are rejected. If the cassette is away, the next material waits at the
descaling exit until it returns. A lost response must be reconciled through GET
status before another move, rather than retried blindly.

The companion Controller demo UI shows the cassette measurements, both work rolls,
and location buttons. Its **Open asset in UNS** / **Open subasset** links lead to
the normal Asset history entrypoints. Physical simulation state is distinct from
the controller's verified identity placement: each of the three identities needs
the normal reviewed provider association and scoped publication permission.
Moves require the existing controller transition gate; they do not enable it.
History follows verified bindings after their normal freshness/grace processing.
Initial measurements before a binding is accepted can remain unattributed.

All three leaves use a fixed `hrm_mobile_equipment` storage group, independent of
location. The publisher drains queued messages before reconciling its produced
topic inventory through Kit's `retainProducedTopics`, dropping only the old
cassette subtree and preserving other station metadata. This does not clear MQTT
values or delete UNS nodes, archived rows or identity history.


### Split an existing completed material (6.1.22)

In the OpenHub demo, open a completed material under **Material details**, expand
**Split material**, and supply two new identifiers. This is different from
**Pieces**, which queues independent furnace inputs. The source is consumed once;
two new batch IDs each receive half its quantity. Outputs enter the warehouse,
inherit source process measurements and quality inspection, and publish their own
entry/exit events with `splitSourceBatchId`, `splitSourceMaterialId`, and
`measurementOrigin=inherited`. No new furnace/rolling measurement is implied.

The registered POST service is `/api/system/hrm/service/rtt-demo-app/material-split`.
Its body contains `sourceBatchId`, `requestId`, and exactly two `outputMaterialIds`.
An identical request returns the same receipt. Changed requests against a consumed
source return409; invalid IDs return400 and an absent source404. Earlier releases
keep batches and receipts in memory. Version 6.1.24 described below
restores them from its durable instance journal after restart. An uncertain UI result blocks another split until its source receipt is
read back. Recorded MQTT history remains independent of the command receipt.

Trace each output to inspect its own visit and the source history. Reported origins
and suggested graph links remain pending until reviewed. The dedicated split/merge
contracts below support their respective cardinalities; ambiguous path candidates
require explicit selection. Earlier evidence recorded under the one-to-one legacy
renumbering contract keeps its original diagnostics and needs separate review.
This is a simulator feature, not a physical cutting, weight or geometry model.


### Reviewed material split and merge evidence (6.1.22)

Material split/merge evidence requires the reviewed `manufacturing.material-traceability`1.2.0 schema package bundled with Controller2.2.12. In Solutions & packages, inspect the package upgrade impact, prepare and recheck the review, then explicitly execute the additive contract upgrade before exercising transformations. Existing renumbering contracts and historical edges are retained.

- A split emits `split-from-material` evidence under `material-split` (one source, multiple outputs).
- A merge emits `merge-from-materials` as one JSON-encoded predecessor list under `material-merge` (multiple sources, one output).
- Normal process-location renumbering continues to emit `previous-material`.
- All new transformation evidence is suggested. In UNS tree, open the material's Object ID menu → Details and review its relationships. An ambiguous identity requires choosing the concrete source path before accepting; a rejected suggestion does not select a path.

The original source batch and inherited inspection provenance remain attached to split outputs. Old evidence is not automatically converted to a different relationship contract or approved in bulk. The simulator's split receipt still belongs to one in-memory run; after an unknown result, inspect the existing receipt rather than issuing a new command.

## Complete transformation manifests (6.1.23)

From demo **6.1.23**, actual split/merge evidence carries a complete declaration.
Upgrade **every Controller writer to 2.2.13 or newer in the 2.x line before
starting this demo**. The package manifest and signed catalog enforce this minimum;
older Controllers cannot decode `uns.relationship-operation.v1`. Apply the normal
Controller schema migrations first. Existing measurement values and topic paths
are unchanged. For reliable recovery when the latest-value cache is cold, use
**UNS API Global 4.1.19 or newer**. Archiver **5.2.23** was used for the installed
MQTT/archive/history acceptance; this release requires no archiver schema change.

The scalar evidence value carries a JSON string with this structure:

```json
{
  "format": "uns.relationship-operation.v1",
  "manifest": {
    "version": 1,
    "operationId": "d02cb541-39c3-4a88-bcf2-5e75dd4be817",
    "kind": "split",
    "occurredAt": "2026-10-18T12:00:00.000Z",
    "inputs": [{"objectType":"material","objectId":"slab-3","fullTopic":"example/warehouse/material/slab-3/"}],
    "outputs": [
      {"objectType":"material","objectId":"piece-a-3","fullTopic":"example/warehouse/material/piece-a-3/"},
      {"objectType":"material","objectId":"piece-b-3","fullTopic":"example/warehouse/material/piece-b-3/"}
    ]
  },
  "value": "slab-3"
}
```

Every split output repeats the **same** immutable manifest and operation UUID.
A merge declares all rolling-stand inputs and its warehouse output; its `value`
is the existing JSON-encoded predecessor list. The outer scalar wire format
lets latest-value caches and archives retain the declaration without special
columns. Endpoint lists are bounded to 32 distinct concrete material identities;
unknown fields require another protocol version. No quantity-conservation or
physical execution guarantee is inferred from this declaration.

Controller review remains blocked until every expected link resolves and matches
the declaration. Missing events stay pending, even after restart; identical
replays preserve reviewed evidence. Conflicting content with the same UUID is
blocked for operator investigation. Old evidence without a manifest remains
readable and individually reviewable, but cannot prove a complete operation.

Through 6.1.23, simulator batches, split request replay and generated UUIDs
remain scoped to the current simulator run. Version 6.1.24 adds local
restart persistence; the manifest alone does not make this industrial
production execution software.


Operator guide: [review a complete split or merge](https://www.uns-openhub.com/docs/guides/demo/materials-and-trace/).
Upgrade the readers first; if reverting a Controller below 2.2.13, stop this
manifest-emitting producer beforehand. Stopping it does not convert archived
manifest values back to older scalar evidence. Reviewed legacy conversion is a
separate operation; do not overwrite history to force compatibility.


### Durable material commands — since 6.1.24

The ordinary simulator initialization opens `hrm-runtime-state.json` in the
instance working directory. `hrm.commandStateFile` may select an explicit absolute
path instead. Keep that directory/file with the instance. The journal contains
synthetic material state, recipes, cassette readings, accepted command results and
pending critical publications; it is runtime data and must not be committed.
A single local writer is permitted. This is not cross-host handover or shared
network-filesystem coordination.

- POST `batch` accepts an optional `requestId` (1–100 letters, digits, dot,
  underscore or hyphen). Repeating the same input and ID returns its original
  batch response after restart. Changed input under that ID returns409. Older
  clients without an ID use a deterministic per-material command identity.
- POST `material-split` retains its existing required `requestId`. The source,
  result, output batch IDs and full producer manifest are committed together.
  Pending split outputs and partially consumed merges resume after restart.
- GET `material-command-result?requestId=...` reads the saved command receipt
  without running the command. A missing result is **not cancellation** of a
  delayed request. Use the same input/ID if retrying; do not invent a replacement
  ID because a response was lost. A legacy load result can be looked up as
  `legacy-submit:<materialId>`.
- API status/config includes `commandDurability` (state, pending publication
  count and protocol). The CLI prints its generated command ID before sending.
- Critical lifecycle/evidence publications are saved before transmission and
  removed only after the transport and SDK publish-drain complete. Retry may
  deliver identical timestamped events more than once; it does not create a new
  business operation. This is not an archive-commit acknowledgment or an
  exactly-once MQTT guarantee. Continuous equipment telemetry is not journaled.

The journal is checksummed, written via fsync/atomic rename and configuration
bound. Corrupt or incompatible journals block startup rather than reset history.
A storage failure blocks further changes and returns503 with an unknown-outcome
instruction; restart and check the **original** command result. A stale cassette
move remains a normal conflict and does not stop the runtime.

Limits are 2,000 retained batches, 4,096 command receipts, 4,096 pending critical
publications and a 16 MiB journal. Old command IDs are never evicted to make a
retry appear new. Hitting a limit requires operator review of the preserved
instance; automatic pruning/migration is not provided. Interrupted `.pending-*`
files are never treated as committed state and may remain for inspection.

First start from an older release cannot recover its already-lost in-memory run.
Finish that run or begin a separate demo dataset before introducing 6.1.24. Restarting with the same journal is tested; moving to another host,
version/instance migration and power-loss/storage-controller guarantees are
outside this slice. Existing HTTP authentication and route permissions remain
required; result lookup grants no additional rights.
