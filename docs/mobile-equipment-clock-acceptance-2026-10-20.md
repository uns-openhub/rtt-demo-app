# Mobile equipment observation clock — local acceptance, 20 October 2026

Status: local clock fix accepted within verified identity intervals. No production,
commit, publication or release. First unbound packets are explicitly retained and
excluded from identity history; no all-raw-rows claim.

## Contract before integration testing

Fix only the mobile observation timestamps. Keep process simulation time, physics,
IDs, paths, journal format and recorded history. Run at 60x with a configured
simulation anchor using the retained `context_demo_20261020` database and original
`ctxdemo1` journal. Reuse the same three saved views, dashboard and Catalog offers.
Old rows and previous proof remain unchanged; new telemetry must not inherit the
old journal's simulated future clock. Never widen identity query intervals.

| Scenario | Expected | Actual |
| --- | --- | --- |
| Automated regression | Tick, three moves and checkpoint restore use wall time; process time remains configured; actual MQTT payloads use wall time | 11 targeted tests pass, including three new regressions |
| Repeated local move | Three independently confirmed identities, stand/store/workshop/stand | See final results below |
| Archive comparison | All post-fix temperature rows within confirmed intervals match API exactly, with every visited path represented; separately account for pre-confirmation rows | See final results below |
| Saved context | Original three views, dashboard and Catalog IDs/specs unchanged and reopened through browser | See final results below |
| Preservation/recovery | Old row multiset, receipts, commands and journal retained; same instance restart | See final results below |
| Cleanup | Stop owned services after drain, revoke temporary identities, restore original config/Setup, retain data/volumes | See final results below |

Controller knowledge index: `/private/tmp/openhub-j21-context-demo-20261020`,
branch `aljosavister/j21-context-evidence-demo`, base `9f433f3`. Demo implementation:
`/private/tmp/openhub-mobile-clock-20261020/demo`, branch
`aljosavister/mobile-equipment-observation-clock`, base `30d9cf7` (6.1.25).

## Final result

The retained journal was copied to a new temporary instance because the original
service principals were revoked. Original instances and journal bytes remain.
The final corrected run resumed at workshop and moved workshop → store → stand;
the preceding wall-clock round had moved stand → store → workshop. All three
identities reached 3/3 confirmation. Each asset has 397 new temperature rows,
395 inside verified binding intervals with exact raw API/QuestDB equality across
all three paths. Two first unbound packets precede metadata registration by
8–38ms and remain unresolved; later rows are complete inside verified intervals.
No old timestamps or identity boundaries were rewritten. All 3,102 pre-final
rows, original saved views/dashboard/Catalog selectors, material command results
and both earlier split/merge receipts were retained after actual demo restart.

71 serial tests and one API declaration test passed; typecheck/build/diff check
passed. The normal parallel suite has a publication-order test failure also
reproduced on the unchanged base; no successful CI/release claim. Owned services
stopped and credentials revoked, original runtime modules/config/Setup restored.
Full synthetic proof is retained by the private Controller acceptance record
`docs/mobile-equipment-clock-acceptance-2026-10-20.md` in the context-demo worktree.
This closes the bounded local demo slice; broader feature work is separate.

## Release preparation — 6.1.26

The parallel-test defect is fixed by waiting for the fixture receiver's explicit
`publication-held` IPC acknowledgement before killing the child. The existing
byte-for-byte replay assertion, process-crash checks and parallel test execution
remain enabled. HTTP response loss alone no longer stands in for observed delivery.
Two complete normal parallel `pnpm run verify` executions passed locally, including
the unchanged byte-for-byte replay assertion, typecheck, build and API declaration
test. The second execution used release version 6.1.26. The release gate runs
the normal suite, not only serial tests.
Controller-owned dated execution evidence stays unchanged; this follow-up records
the later harness fix rather than relabelling the earlier failed test output.
