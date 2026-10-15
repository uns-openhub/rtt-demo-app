# Reviewed lifecycle runtime — G2-07–09 development contract

Local opt-in implementation; not yet released. Ordinary demo profiles omit this
configuration and keep their existing behaviour. This is a technical runtime
handoff guide, not a new end-user Help site.

## Purpose and trust boundary

The Controller can export the exact active State and adapted Action definitions
from a committed, actor-bound G2-06 operation. The export contains no credentials.
In the committed result, choose **Prepare demo contract export**, then download
the file and record the displayed SHA-256 digest through the trusted operator
channel. The protected export rechecks the current registry snapshot. Retain the
operation request if an export must later be obtained through the API; the dialog
does not yet provide a browser for old committed receipts.

Configure the demo with that file **and a separately trusted digest**. The file
is not signed, is not a bearer token and does not prove the Controller's registry
remains unchanged forever. A self-declared digest inside an untrusted file is
insufficient. There is no automatic download, registry watch or fleet rollout.

The runtime accepts a deliberately smaller contract class: one State with plain
edges and 1–10 entity Actions with explicit `from` transitions. Unsupported fields
such as additional Action inputs, policies or side effects fail validation.

## Configuration

Add this optional section inside the existing `hrm` configuration, using private
instance-owned paths on a local persistent filesystem:

```json
{
  "reviewedLifecycle": {
    "contractFile": "/absolute/instance/reviewed-demo-contract.json",
    "contractDigest": "sha256:<64 lowercase hexadecimal characters from trusted export>",
    "stateFile": "/absolute/instance/reviewed-lifecycle-state.json",
    "maintenanceState": "maintenance"
  }
}
```

The placeholder digest must be replaced with the actual digest. Neither file may
be an existing symlink. The journal and contract must be different files. Keep
the state file across restarts; do not delete it as a way of adopting a contract.
The first start without a journal uses the reviewed model's initial state.

In `maintenance`, the actual production line holds new material before entry
to the rolling stand. In-flight or uncertain lifecycle writes and a contract
awaiting adoption also block new rolling. Actions/adoption require an empty
rolling stand. Existing cassette location interlocks still apply. This feature
does not abruptly stop an already rolling material or control physical devices.

## API commands and receipts

The existing `system/hrm/service` service route registration exposes these
attributes; use the normal discovered/proxied demo API URL and existing
authentication rather than assuming an instance URL:

| Method / attribute | Purpose |
| --- | --- |
| GET `status` | Includes optional `reviewedLifecycle`: state, revision, health, accepted/offered digest, action availability |
| POST `reviewed-lifecycle-action` | Execute one explicit Action |
| POST `reviewed-lifecycle-adopt` | Adopt the configured direct successor without resetting current state |
| GET `reviewed-lifecycle-result?operationId=<uuid>` | Stored receipt plus current lifecycle status |

Action body:

```json
{
  "operationId": "<new UUID saved before sending>",
  "expectedExecutorId": "<executorId from fresh status>",
  "expectedRevision": 0,
  "expectedContractDigest": "sha256:<accepted digest from status>",
  "actionKey": "<reviewed qualified Action key>"
}
```

For adoption, replace `actionKey` with `newContractDigest` matching the configured
offered digest. These are separate commands with separate UUIDs. Compare current
status before each new command. Malformed, stale, conflicting, unavailable and
uncertain writes return 409; inspect status and the stored result before deciding
what to do. Result lookup requires a valid UUID (otherwise 400).

Save the full request and its operation ID before sending. If the response is
lost, query that ID and retry **only the identical request**. Receipt lookup
precedes current revision checking, so the same command can recover after a
restart or later state changes. Reusing an ID with another body is rejected.
A missing result while `inFlight` or `health: unknown` is not evidence of failure.
Do not create a second command to work around an unknown outcome.

For a correction: obtain a newly reviewed successor export, install its file and
trusted pin, then restart. Existing journal state remains intact and reports
`adoption_required`; new rolling stays blocked. Explicit adoption checks the
direct predecessor snapshot, stable model/Action identities and retained values.
After adoption, a separate reviewed Action may leave maintenance if the accepted
model permits it. No forced initial-state reset is performed.

## Persistence and recovery boundaries

Each command stores state and its receipt together: private temporary file,
file fsync, atomic rename, then directory fsync. A write error marks the live
runtime unknown and blocks further new commands and rolling. Restart reads the
durable journal and resolves whether the original command was committed. A
corrupt, oversized or inconsistent journal fails startup; it is never silently
reset. Preserve it and diagnose/restore it with the instance stopped.

The single writer lease uses an exclusive loopback TCP reservation derived from
the canonical state path. It serves no API or data and the OS releases it after
process death. A reservation collision fails closed. This protects one path on
one host; it is not a distributed/NFS/fleet lock. Do not run aliases or copies of
one journal on multiple hosts. The directory must be trusted and writable only
by the instance owner; checksums detect corruption, not a malicious local owner.

The journal holds at most 256 receipts and 1 MiB. Reaching capacity blocks new
commands; it does not evict idempotency evidence. Plan an explicit new demo
session while preserving the old journal. Temporary files left by a killed
writer are not automatically deleted or treated as committed state.

Only the reviewed lifecycle and receipts persist here. Normal simulator jobs,
physics state and MQTT delivery have not gained persistence in this change.
Local acceptance covers process SIGKILL before/after rename, normal restarts,
lost HTTP responses, an injected post-rename I/O error, contract adoption and
corruption refusal. It does not certify a host power cut, disk loss, production
rollout, MQTT end-to-end delivery or concurrent fleet execution.

## G2-08 operator review and recovery (local development)

The Controller's `/demo/hot-rolling` operator screen renders an **Execution
contract** panel when this optional runtime is configured. It shows accepted and
offered versions, current state, eligibility/reason and expandable exact pins and
Action transitions. **Review adoption** re-reads actual runtime status; a separate
checkbox enables **Adopt reviewed contract**. Cancellation sends no command.
The runtime still checks revision, accepted/offered pins, direct predecessor,
retained state and the rolling-stand guard at execution time.

The UI stores the exact adoption request in tab-scoped session storage before
sending. If storage cannot be written, no command is sent. After a timeout,
rejection or lost response, it retains that request and blocks a new adoption.
**Check saved result** reads its receipt; **Retry identical operation** reuses the
same body and UUID. Reopening/reloading the tab restores and checks this pending
operation, without automatically sending another POST. Browser recovery depends
on preserving this tab's session storage; no cross-device recovery browser or
historic operation picker is implemented.

Runtime status/receipts now expose a durable random `executorId`. The UI includes
`expectedExecutorId` in its adoption request; a different journal cannot accept
or confirm it. This identity survives process restart. Valid older G2-07 journals
without the field gain it through one atomic write, preserving state, revision,
contract and all receipts. Existing API callers without the optional pin remain
compatible; operator UI writes always supply it. It is an executor-journal
identity, not an authenticated user's identity or a distributed lock.

Unknown live write outcomes instruct the operator to restart the demo using
Micro services and then check the saved operation. The panel cannot reset or
remove a journal and cannot restart a process. A missing receipt never proves an
earlier HTTP request cannot arrive. If a saved command is permanently stale or
its original journal is unavailable, new adoption remains blocked. G2-09 below
adds reviewed closure on the reachable original journal; cross-device recovery
remains separate work. Do not clear browser recovery
records or reset the journal to bypass that guard.

Authorization continues through the existing JWT and API-path access rules.
No new service identity, credential, scope or anonymous product endpoint is added.
The UI does not install a contract file, run a State Action or roll out a fleet.
The trusted file/digest preparation described above remains a separate step.

## G2-09 — closing an unresolved attempt (local development)

A healthy original executor advertises `closureSupported` and `closureAvailable`.
The operator can choose **Review closing this attempt**, inspect fresh status and
acknowledge **Close reviewed attempt** separately. No closure is sent during
review/cancel. POST `reviewed-lifecycle-close` carries:

```text
{
  adoption: <the entire original pinned adoption request>,
  expectedRevision: <current journal revision>,
  expectedContractDigest: <current accepted fingerprint>,
  expectedOfferedContractDigest: <current offered fingerprint>,
  acknowledgeClosure: true
}
```

The runtime serializes closure with all lifecycle writes. If the original ID is
already applied, it returns that applied receipt. Otherwise exact review pins,
original executor, journal capacity and healthy/no-in-flight write are required.
One atomic journal event records `outcome: closed`, the full original request and
closure-request digest. State and accepted contract stay unchanged; the journal
revision increments once. Any late execution of that original ID is rejected,
including after restart. Never interpret a closed receipt as an applied adoption.
Older applied receipts without an outcome field retain their original semantics.

The browser saves the closure body before POST, alongside the original request.
Lost or rejected replies keep both records and block new adoption. **Check saved
result** recovers the original ID's terminal applied/closed receipt. **Retry
identical closure** reuses its exact saved body. If the closure review itself
became stale, **Review updated closure** explicitly rechecks current pins and
requires another acknowledgement for the same original adoption ID. Only after
that acknowledgement is the saved closure body replaced. A delayed older closure
can only close that same original ID (or return its actual applied result); it
cannot adopt a contract or target a new ID. Receipt lookup resolves which closure
won. Adoption retry remains disabled once a closure has been sent.

Only a matching terminal receipt allows browser cleanup and a fresh adoption
review with a new ID/current revision. Partial cleanup can reconstruct the
original operation from the saved closure body. If the executor/journal is
unavailable, has an unknown write outcome, is busy/full or fails integrity checks,
closure remains blocked. Restart/read-back may resolve uncertainty; the UI never
removes or resets journal data. Closure consumes a receipt slot and old evidence
is never silently evicted. An unavailable original journal and cross-device
recovery remain outside this slice. No new credentials or API authorization
policy are introduced.

## Release and rollback preparation

This optional protocol changes the Controller and demo repositories only. It
requires no new Kit/API Global release, database migration or GraphQL schema.
Install the matching Controller UI before enabling this runtime. Deploy the new
demo with its normal configuration first; profiles without `reviewedLifecycle`
retain their existing behaviour. Provision the reviewed file and independently
trusted pin only after checking the normal registered service route, JWKS
authentication and caller API-path permissions. The isolated acceptance server
does not certify that deployment boundary.

G2-10 local acceptance additionally checks the ordinary installed entrypoint,
MQTT service registration, Controller/public proxy and actual JWKS-signed
callers. A status-only client reads status but cannot adopt, execute, close or
read operation receipts. Missing, malformed, expired, tampered and foreign-key
tokens fail. The compiled operator UI performs closure and fresh adoption, and
normal instance restart retains the journal/receipts. This is local acceptance,
not a production/fleet, key-rotation or online revocation propagation certificate.

Kit access rules refer to the **logical UNS route**, excluding the HTTP mount:
for `/api/system/hrm/service/rtt-demo-app/status`, grant only
`system/hrm/service/rtt-demo-app/status`. The `/api` prefix is a transport mount;
it is not part of the logical permission rule. Status-only permission does not
grant the sibling mutation or receipt paths. Use separate bounded permissions
for an operator who should perform those actions.

Retain the instance's journal, contract files, pins and exact pending requests
across upgrade/restart. A Controller registry commit and a demo adoption are
separate audited operations; upgrading binaries does not deliver or adopt a
contract. State changes require another explicit permitted Action.

Older binaries are not a supported rollback for a journal that has gained new
receipt fields or closed outcomes. Preserve the current journal and recover with
this reader or a newer compatible one. Use a newer reviewed corrective contract
for semantic correction; do not delete the journal, restore a stale browser
request as a new operation, or downgrade the package as a recovery shortcut.
The default profiles are unchanged, but that does not make opted-in state
backward compatible. Single-host storage, bounded receipt capacity, manual file
delivery, tab-scoped recovery and undeclared external-consumer limits remain.
