# ops/_shim (lane B, Wave 1 only)

Stand-ins for lanes that are not merged yet. **Wave 2 replaces every file here.**

| File | Stands in for | Replace with |
| --- | --- | --- |
| `repo.ts` | lane A repository layer (row <-> contract conversion, insert/update/select) | `packages/engine/db` repositories |
| `db.ts` | lane A migration runner | `packages/engine/db` runner |
| `decisions.ts` | lane I resolver: `decide()` over the policy grid + decision row writes | `@perfect-placement/resolver` (`decide`, decision log) |
| `extra-ops.ts` | contract ops requested in CONTRACT_CHANGES.md (`runs.finish`) | `packages/contracts` once accepted |
| `testing.ts` | test helper: temp PP_HOME from the fixture vault + seed | keep for tests, or lane A's fixture loader |

Nothing outside `packages/engine/ops` imports from here except tests.
