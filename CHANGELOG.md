# Changelog

## v0.2.0 (2026-11-26)

- Added an optional Lean 4 cross-check for supported `bigint` contracts. Verification reports show the Z3 and Lean verdicts for each obligation and whether the engines agree.
- Added multiplication and division for `bigint` and JavaScript `number`. Both Z3 and Lean check that evaluated `bigint` divisors are nonzero and that quotients truncate toward zero.
- Extended verification to `switch` statements, ternary expressions, initialized local variables, standalone assignments, and local object and array destructuring.
- Added a Vite plugin that verifies selected modules during production builds and removes their contract declarations from the bundle. [Vite setup](docs/vite.md)
- Updated Z3 to fix a garbage-collection race that could crash repeated verification.
- Added an [English usage guide](docs/usage.md) and updated the [Russian guide](docs/usage.ru.md).

## v0.1.0 (2026-11-12)

- Introduced TypeScript value contracts with `requires` and `ensures`, Z3 verification for supported `bigint`, `number`, and UTF-16 string expressions, and generation of regression and property-based tests.
