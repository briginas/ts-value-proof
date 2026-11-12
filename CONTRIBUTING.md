# Contributing

Use Node.js `^24.12.0 || >=26.0.0` and run commands from the repository root:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` includes type checks, verifier checks, replay, and property-based tests.
Generated fixtures and reports go into the ignored `work/` directory. Passing
tests does not formally prove the verifier correct.

For features, bug fixes, API changes, or changes to supported behavior, use an
OpenSpec change. Prepare its proposal, design, delta specs, and tasks before
implementation. Add relevant tests and documentation; check off tasks only after
validation. When complete, sync delta specs, validate, archive the change, and
commit the implementation together with its OpenSpec artifacts.

Documentation and contributor-instruction edits that do not change behavior can
be made directly. Prefer TypeScript and `type` over `interface` unless specific
interface features are needed. Keep pull requests focused and include validation
results.

See [AGENTS.md](AGENTS.md) for project rules and [specifications](openspec/specs/)
for supported behavior. OpenSpec workflow skills in `.agents/skills/` are tracked
so contributors share the same instructions; they are not required to run the project.
