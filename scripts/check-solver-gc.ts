import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { init } from "z3-solver";
import { adapt } from "./adapter.ts";
import { verifyProgram } from "./verification.ts";

async function main() {
  const collect = global.gc;
  assert(collect, "Run this check with node --expose-gc");
  const { Context } = await init();
  const ctx = new Context("gc-regression");
  const x = ctx.Int.const("x"), y = ctx.Int.const("y");
  const held = [ctx.Bool.val(true), ctx.Bool.val(false), x.ge(0), x.add(y)];
  const before = held.map(term => term.toString());
  let checking = false, collectedDuringCheck = 0;
  const registry = new FinalizationRegistry(() => {
    if (checking) collectedDuringCheck++;
  });
  function garbage(round: number) {
    for (let i = 0; i < 2000; i++) {
      const value = ctx.Int.const(`garbage-${round}-${i}`);
      registry.register(value, undefined);
      value.add(i).mul(value).ge(i);
    }
  }
  const huge = -90071992547409931234567890123456789n;
  for (let round = 0; round < 20; round++) {
    garbage(round);
    const hard = new ctx.Solver();
    hard.set("timeout", 100);
    hard.add(x.gt(1), y.gt(1), x.mul(y).eq(100000000000000000000000000000000000000000000000151n));
    checking = true;
    // No Z3 API calls on the main thread while the worker is running.
    // GC finalizers are the only source of concurrent native cleanup here.
    const timer = setInterval(collect, 5);
    let status;
    try { status = await hard.check(); }
    finally { clearInterval(timer); checking = false; }
    assert(["sat", "unsat", "unknown"].includes(status));
    if (status === "unknown") assert(hard.reasonUnknown().length > 0);
    // The hard query may time out; the checks below must actually decide.
    assert.deepEqual(held.map(term => term.toString()), before);
    assert(held.slice(0, 3).every(term => ctx.isBool(term)));
    assert(ctx.isInt(held[3]));
    assert(ctx.isBool(ctx.Bool.val(true)));
    assert(ctx.isInt(ctx.Int.val(123)));
    const exact = new ctx.Solver();
    exact.set("timeout", 5000);
    exact.add(x.eq(huge), y.eq(round));
    assert.equal(await exact.check(), "sat");
    const value = exact.model().eval(x.add(y), true);
    assert(ctx.isIntVal(value));
    assert.equal(value.value(), huge + BigInt(round));
    exact.add(ctx.Not(x.eq(huge)));
    assert.equal(await exact.check(), "unsat");
  }
  assert(collectedDuringCheck > 0, "No collectible wrappers were finalized during pending queries");
  console.log(`PASS 20 solver GC rounds; ${collectedDuringCheck} wrappers finalized during pending queries`);

  const directory = path.resolve("work/solver-gc");
  fs.mkdirSync(directory, { recursive: true });
  const contract = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  function program(name: string, source: string) {
    const entry = path.join(directory, name + ".ts");
    fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(contract)};\n${source}`);
    return adapt(entry);
  }
  const correct = program("correct", `
function f(x:bigint,y:bigint):bigint{return y===0n ? 0n : x/y;}
contract(f,{ensures:(r,x,y)=>y===0n ? r===0n : r===x/y});`);
  const incorrect = program("incorrect", `
function f(x:bigint):bigint{return x/3n;}
contract(f,{requires:x=>x===${huge}n,ensures:r=>r===0n});`);
  const limited = program("limited", `
function f(x:bigint,y:bigint):bigint{return x/y;}
contract(f,{ensures:r=>r>=0n});`);
  let collections = 0;
  const timer = setInterval(() => { collect(); collections++; }, 5);
  try {
    for (let round = 0; round < 10; round++) {
      const proved = await verifyProgram(correct);
      assert.equal(proved.length, 1);
      assert.equal(proved[0].status, "proved");
      const refuted = await verifyProgram(incorrect);
      assert.equal(refuted.length, 2);
      assert.equal(refuted[0].status, "satisfiable");
      const violation = refuted[1];
      assert.equal(violation.status, "disproved");
      if (violation.status !== "disproved") throw new Error("Expected exact counterexample");
      assert.equal(violation.counterexample.x, `${huge}n`);
      assert.notEqual(BigInt(String(violation.counterexample.x).slice(0, -1)) / 3n, 0n);
      const unknown = await verifyProgram(limited, { resourceLimit: 1 });
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0].status, "unknown");
      assert("reasonCode" in unknown[0] && unknown[0].reasonCode === "solver-unknown");
      assert(!("counterexample" in unknown[0]));
    }
  } finally { clearInterval(timer); }
  assert(collections > 0, "No GC requests occurred during project verification");
  console.log("PASS 10 bigint verification rounds under GC: proofs, exact counterexamples and resource limits");
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
