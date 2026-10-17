# rtt-demo-app 6.1.20

Patch over 6.1.19.

- Resolve both MQTT channels before connecting and forward the SDK connection
  settings to the process and output proxy: configured ports, authentication,
  TLS, server pools and reconnect settings. Preserve SDK lifecycle and handover.
- Publish material temperature for every occupied furnace slot from its first
  tick. The lead material still publishes the common equipment snapshot once
  per tick. Each asynchronous publication receives an independent tick snapshot.
- Preserve material IDs, paths, batch grouping, timestamps and history format.
  No schema migration or configuration change is required.

## Verification

41 tests, typecheck and build passed locally. Regression coverage includes default
and explicit MQTT settings, output overrides, invalid preflight, concurrent
furnace occupancy, per-material paths and immutable publication snapshots.
A local actual MQTT -> archiver -> automatic history API/browser run with the
companion Controller candidate preserved 20/20 transitions and 28/37 furnace
samples for two concurrent materials; saved aligned comparison survived a
Controller-only restart. Temporary local credentials were revoked after testing.

CI and release checks must pass before publication. This source publication does
not install the demo in production. Pieces creates independent inputs; splitting
one existing material into successors is not implemented by this patch.
