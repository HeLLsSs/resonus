# Unit tests

Tests for the parts of the app that are plain logic, one file per module
under `src/`. Nothing here starts an emulator or a bundler.

## Running

```sh
pnpm test                                    # everything
pnpm test -- --test-name-pattern=sortItems   # the tests whose name matches
node --experimental-transform-types --import ./test/register.mjs --test test/librarySort.test.ts   # one file
```

(`pnpm test -- test/librarySort.test.ts` would add the file to the glob the
script already names, and run everything.)

The runner is Node's own (`node --test`), on Node 22.18 or newer, with the
same loader the repository's scripts use (`scripts/ts-resolve.mjs`): Node
strips the TypeScript itself, and the hook turns `@/lib/thing` and the app's
extensionless relative imports into files under `src/`. `--experimental-transform-types`
is on because strip-only mode refuses some TypeScript the app writes, a
constructor parameter property for one.

Each `test/<module>.test.ts` covers one module under `src/` and is written
with `node:test` and `node:assert/strict`. The files are typechecked with the
rest of the project (`pnpm typecheck`) and linted with `eslint test`.

## Stubs

The modules under test are pure, but they import things that only exist on a
phone: `expo-*`, `react-native`, the stores, the API client. `test/register.mjs`
answers a fixed list of those with a file from `test/stubs/` instead. An
app module on the list is swapped by the file it resolves to, so it does not
matter whether the importer wrote `@/store/auth` or `./auth`. Anything not on
the list is the real module, so a test that passes here passed against the
code that ships.

Most stubs are also the test's controls: they export an object the test
reads or sets, such as `data` in `api-data.ts` (what the server answers, and
every call made), `storage` in `lib-storage.ts` (the key-value store),
`fileSystem` and `sharing` (what was written and what was shared). A test
imports those with a relative
path (`./stubs/api-data`); it is the same module instance the code under
test received, because both resolve to the same file.

Two stubs deserve a note:

- `expo-crypto.ts` is Node's `crypto` behind expo-crypto's names, with real
  SHA-256 and AES-GCM, so a file sealed with a passphrase is sealed and opened
  for real. Its combined layout is its own; nothing here reads a file the
  phone wrote.
- `lib-localLibrary.ts` hashes a profile scope to something readable rather
  than to the app's FNV hash, so a failing assertion names the scope a key
  was made from.

To stub something new, add the file under `test/stubs/` and one line to the
map in `test/register.mjs`. Keep the list as short as the tests need: every
entry is a piece of the app the tests no longer see.

## Adding a test

Pick a module whose exported functions can be called with plain data. If
the module keeps state between calls (some do), say so at the top
of the file and give each test data of its own rather than resetting
through private state. Assert on behaviour that a person could describe,
not on the shape of an object for its own sake.
