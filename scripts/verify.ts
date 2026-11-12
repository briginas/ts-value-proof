import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verify, failureReport, type VerificationReport } from "./verifier.ts";
export { verify } from "./verifier.ts";
export type { VerificationReport, VerificationResult, SolverLimits } from "./verifier.ts";

export async function runVerifyCli(input: string): Promise<number> {
  function emit(report: VerificationReport): void {
    fs.mkdirSync("work", {recursive: true});
    fs.writeFileSync("work/verification.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  }
  try {
    const report = await verify(input);
    emit(report);
    return report.status === "verified" ? 0 : report.status === "unknown" ? 2 : 1;
  } catch (error) {
    emit(failureReport(input, error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exit(await runVerifyCli(process.argv[2] ?? "examples/withdraw.ts"));
