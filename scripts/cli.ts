#!/usr/bin/env node
import { runVerifyCli } from "./verify.ts";

const [command, input, ...rest] = process.argv.slice(2);
if (command !== "verify" || !input || rest.length) {
  console.error("Usage: ts-value-proof verify <entry.ts>");
  process.exit(2);
}
process.exit(await runVerifyCli(input));
