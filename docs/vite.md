# Vite integration

`ts-value-proof/vite` verifies selected TypeScript modules during `vite build`,
then removes their contract declarations before Vite compiles the application.
The plugin supports Vite `^8.3.8` and the same limited language as the CLI.

## Install from this repository

The package is private and is not published to npm. From the repository:

```sh
npm ci --ignore-scripts
npm run build:package
npm pack --ignore-scripts
```

In the consuming project, install the resulting tarball and Vite:

```sh
npm install --save-dev /absolute/path/to/ts-value-proof-0.1.0.tgz vite@^8.3.8
```

Node.js `^24.12.0 || >=26.0.0` is required. `build:package` compiles this tool;
it is not a replacement for your application's build command. The tarball
contains JavaScript and declarations, so it does not require Node to execute
TypeScript inside `node_modules`.

Use an ESM consuming project (`"type": "module"` in `package.json`). The verifier
uses strict TypeScript with NodeNext resolution independently of your tsconfig;
Vite-specific resolution settings do not expand the supported verification language.

## Configure Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { valueProof } from "ts-value-proof/vite";

export default defineConfig({
  plugins: [
    valueProof({
      entries: ["src/math.ts"],
      // Optional, per solver query:
      limits: { timeoutMs: 5000 },
    }),
  ],
});
```

```ts
// src/math.ts
import { contract } from "ts-value-proof";

export function increment(value: bigint): bigint {
  return value + 1n;
}

contract(increment, {
  ensures: (result, value) => result > value,
});
```

Keep using your usual `vite build` / `npm run build`. The emitted JavaScript
contains `increment`, but no contract call, predicate, or contract API dependency.
This does not depend on tree shaking. Sources on disk remain unchanged.

`entries` is a required non-empty array, resolved relative to Vite's `root`.
Each entry includes its reachable local dependencies. Prefer small library
modules that fit the supported language; UI, DOM and other application modules
outside these graphs are built normally and are **not verified**. A separate
contract file can be an entry even when the application only imports its implementation.
Every selected graph must contain at least one contract.

Aliases and re-exports of the trusted API are supported. Other runtime packages,
Vite aliases inside the checked graph, resource query imports of checked modules,
and use of the returned `contract()` object are not a supported verification API.
The plugin pins local imports in checked modules to TypeScript's resolved files;
Vite aliases cannot substitute a different implementation for these edges.
Reaching the trusted contract API from an unchecked module fails the build:
include that module in an appropriate verification entry. Checked module dependencies
and the contract API cannot be externalized to bypass this processing.

## Verification and builds

All selected graphs must return `verified`. `refuted`, `inconsistent`, `unknown`,
type errors and unsupported syntax stop the build. No new bundle is emitted by
that failed build; existing output from earlier builds is not a new success.

The plugin verifies and erases from one source snapshot, checks incoming source
text, and checks that inputs have not changed before emitting the bundle.
Changed inputs require a rebuild. Place it before other `enforce: "pre"` plugins
that change the checked source. Subsequent transpilers, optimizers and other
plugins are trusted to preserve the meaning of the checked functions; this tool
does not prove the correctness of the compiler pipeline.

`vite build --watch` checks each iteration, including changes to separate contract
files and type-only dependencies. `vite dev` does not run the verifier or remove
contracts. The contract API never enforces runtime assertions in either mode.
External callers must still supply correctly typed inputs satisfying `requires`.

Source maps map the transformed code to the original TS and may contain the
original contracts in `sourcesContent`. They are not executable contract code;
whether to publish source maps is your application's build setting.

## Independent verification

```sh
npx ts-value-proof verify src/math.ts
```

This uses the same verifier without requiring Vite and does not generate JS.
It prints JSON and writes `work/verification.json`: exit 0 is `verified`,
1 is `refuted` / `inconsistent`, and 2 is `unknown` or an input/tool error.

```ts
import { verify } from "ts-value-proof/verify";

const report = await verify("src/math.ts", { timeoutMs: 5000 });
console.log(report.status);
```

The programmatic API preserves existing behavior: input errors such as invalid
types or unsupported syntax throw; an unsupported numeric model returns `unknown`.
The CLI converts thrown errors to a diagnostic report. The runtime import
`ts-value-proof` only provides contracts and types; it does not import Z3 or Vite.

## Development checks

```sh
npm run test:build   # real Vite builds, source maps, failures and native watch
npm run test:package # isolated npm install, CLI without Vite, types and Vite build
```

The package smoke test needs npm registry access on a cold cache. It uses a
temporary consumer project and the ignored `work/npm-cache` directory.
The native watch test needs an environment that allows filesystem watching.
