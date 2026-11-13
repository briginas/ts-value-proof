# Design

## Context

The bigint backend caches a high-level Z3 context; the number/string backend uses per-run non-RC low-level contexts with explicit solver/model/parameter release. Public verification is serialized, but that queue cannot synchronize `FinalizationRegistry` callbacks inside the dependency. See proposal.md for the observed failure.

The published `z3-solver@5.4.1` JS binding enables concurrent decref for its contexts and coordinates asynchronous queries with other finalizer cleanup. This is an upstream fix in the distributed package, not only an unreleased branch.

## Goals / Non-Goals

**Goals:** Adopt upstream lifetime protection without taking ownership of dependency internals; exercise GC during worker activity and preserve existing backend semantics.

**Non-Goals:** Rewrite either backend, add a global finalizer monkey patch, change public APIs, or assert that a finite stress test formally proves correctness.

## Decisions

- Pin `5.4.1` in package metadata and lockfile. Verify the installed artifact and run typecheck against both API layers. A local monkey patch would depend on private module internals; a low-level bigint rewrite would duplicate ownership code and expand this fix unnecessarily.
- Add a standalone TypeScript GC check, launched by a Vitest test in a child Node process with `--expose-gc`, a bounded timeout, and forced termination on a hang. Integrate it into the default test command and provide `test:solver` for focused runs.
- Create collectible arithmetic terms, start a bounded nonlinear query, and force GC while awaiting it. Check retained term identities, sorts, known satisfiable/unsatisfiable obligations, and exact model values afterwards. Allow a legitimate solver timeout on the deliberately hard query; never treat that timeout as proof. Confirm that GC actually ran during pending checks.
- Also repeat project-level bigint verification under GC, checking proved/disproved results, exact large-integer counterexamples, and resource-limit unknowns. Keep the standalone dependency probe and project checks distinct so failures remain diagnosable.
- Keep stress workload bounded and sequential. Use the original `4.16.0` dependency in an isolated diagnostic location to demonstrate the test detects the prior race, without changing the project's installed dependency back and forth.

## Risks / Trade-offs

- A major dependency upgrade can change solver answers, models, or performance → run all existing semantic tests, CLI/Vite checks, package smoke, and repeated division/GC tests; adjust only compatibility issues within existing requirements.
- GC scheduling is nondeterministic → explicitly request GC while a worker query is pending, keep repeated rounds and verify collection activity; interpret repeated success as regression evidence, not proof of absence of all races.
- Native corruption can crash or hang the child → enforce a parent deadline with SIGKILL and report child output on failure.

## Migration Plan

Install the exact dependency, add and run focused checks, then run the full suite and package smoke. Document results before syncing/archiving the change and committing. A rollback to `4.16.0` restores the known race and must not be described as a fix.
