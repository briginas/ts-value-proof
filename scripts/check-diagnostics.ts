import fs from "node:fs";
import assert from "node:assert/strict";
import type { SourceLocation } from "./ir.ts";
import type { VerificationReport } from "./verify.ts";

// Check locations against source text, independently of the adapter's IR.
export function assertLocation(source: SourceLocation, expectedText: string): void {
  const text = fs.readFileSync(source.file, "utf8");
  assert.equal(text.slice(source.start, source.end), expectedText);
  const lines = text.slice(0, source.start).split("\n");
  assert.equal(source.line, lines.length);
  assert.equal(source.column, lines.at(-1)!.length + 1);
}

export function assertReportDiagnostics(report: VerificationReport): void {
  for (const result of report.results) {
    assert.ok(result.function);
    assert.ok(result.sourceName);
    const source = fs.readFileSync(result.source.file, "utf8");
    assertLocation(result.source, source.slice(result.source.start, result.source.end));
    assert.match(source.slice(result.source.start, result.source.end), new RegExp(`function ${result.sourceName}\\(`));
    assert.ok(result.condition);
    for (const requirement of result.requires) {
      assert.ok(requirement.condition);
      const text = fs.readFileSync(requirement.source.file, "utf8");
      assertLocation(requirement.source, text.slice(requirement.source.start, requirement.source.end));
    }
    if (result.status === "unknown" || result.status === "inconsistent" || result.status === "disproved") {
      assert.ok(result.reason);
      assert.ok(result.reasonCode);
    }
    if (result.kind === "call") {
      assert.equal(result.callId, `${result.callSource.file}:${result.callSource.start}`);
      assert.ok(result.pathCondition);
      assert.ok(result.checkedCondition);
      assert.ok(result.callee.sourceName);
      assert.ok(result.condition.startsWith(result.callee.sourceName + ": "));
    }
  }
}
