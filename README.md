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

## Release

`package.json` is the version source for this public OpenHub add-on. CI
validates source changes; after a versioned merge, create the matching `vX.Y.Z`
tag and GitHub Release through the repository's separate release procedure.
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
- API/status payloads still expose the business `materialId` (`slab-001`) so external submit/query workflows do not need to know the UNS stage suffix.
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
