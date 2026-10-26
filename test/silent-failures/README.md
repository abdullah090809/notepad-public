# Silent-failure regression suite

Runs the REAL `src/db.ts`, `src/security.ts`, `src/backup.ts`, `src/format.ts`, `src/settings.tsx`,
`src/screens/NoteEditor.tsx` and `src/screens/Revisions.tsx` under Node, with:
- `expo-sqlite` replaced by Node's built-in SQLite (real SQL engine, in memory)
- other native Expo / React Native modules replaced by in-memory fakes (`test/harness/stubs`)
- `ui`, `nav`, `appearance`, `settings` replaced by test doubles ONLY for screens/backup.ts

## Run
    npm install                                  # react-test-renderer is a devDependency
    node --disable-warning=ExperimentalWarning --import ./test/harness/register.mjs --test test/silent-failures/*.test.mjs

Requires Node >= 22.13 (`node:sqlite`). Tests assert the CORRECT behaviour. On the current code **all tests pass**:
the `SF-*` tests used to fail while the defects they describe were present, and a failing `SF-*` test now means a
regression. The `[CONTROL]` tests pin behaviour that was always correct. `audit-fixes*.test.mjs` hold the regression
tests for the independent audit's findings (each finding has a failure-path test and a "no change" test); the
`audit-fixes-db-*.test.mjs` files are separate on purpose, because they need a fresh process (db.ts caches its
connection at module level). `RT-PERF-*` tests use wall-clock limits and can fail once on a heavily loaded machine. `test/harness/stubs/local-settings.mjs` documents why the settings
double must keep stable function identities (an unstable `get` masked two bugs in an earlier draft).
