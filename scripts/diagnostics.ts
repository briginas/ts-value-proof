import path from "node:path";
import type ts from "typescript";
import type { SourceLocation } from "./ir.ts";

export type InputReasonCode = "unsupported-code" | "unsupported-numeric-model" | "type-error";
export class InputDiagnostic extends Error {
  reasonCode: InputReasonCode;
  source?: SourceLocation;
  constructor(message: string, reasonCode: InputReasonCode, source?: SourceLocation) {
    super(message);
    this.reasonCode = reasonCode;
    this.source = source;
  }
}

export function location(node: ts.Node): SourceLocation {
  const source = node.getSourceFile();
  return sourceLocation(source, node.getStart(), node.getEnd());
}

export function sourceLocation(source: ts.SourceFile, start: number, end: number): SourceLocation {
  const { line, character } = source.getLineAndCharacterOfPosition(start);
  return { file: path.resolve(source.fileName), start, end, line: line + 1, column: character + 1 };
}
