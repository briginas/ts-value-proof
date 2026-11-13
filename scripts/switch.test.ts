import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { prettyExpr } from "./ir.ts";
import { returnExpression } from "./ir-integrity.ts";
import { encodeNumber } from "./numeric-values.ts";
import { callPaths } from "./dependencies.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/switch", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import { contract } from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("switch lowers to ordered strict equality branches with shared fallthrough", () => {
  const ir = adapt(fixture("shape", `function f(x: number): number {
    switch (x) { case 1: case 2: return 10; default: return 20; }
  } contract(f, { ensures: r => r === 10 || r === 20 });`));
  const body = ir.functions[0].body;
  expect(prettyExpr(body)).toBe("((x === 1) ? 10 : ((x === 2) ? 10 : 20))");
  expect(body.kind).toBe("ternary");
  if (body.kind !== "ternary" || body.else.kind !== "ternary") throw new Error("missing branch");
  expect(body.then).toBe(body.else.then);
});

test("switch paths agree with native JavaScript across defaults, fallthrough and nested breaks", () => {
  // Bodies are executed independently as native switch code and as lowered Expr.
  const bodies = [
    "switch(x) {} return y;",
    "switch(x) { default: return y; }",
    "switch(x) { case 0: return 10; case 1: return 20; } return 30;",
    "switch(x) { case 0: case 1: return 10; default: return 20; }",
    "switch(x) { case 0: return 10; default: return 20; case 1: return 30; }",
    "switch(x) { default: if(y>0) return 10; case 1: return 20; case 2: return 30; }",
    "switch(x) { case 0: if(y>0) return 10; default: if(y<0) return 20; case 1: return 30; }",
    "switch(x) { case 0: break; case 1: return 10; default: break; } return 20;",
    "switch(x) { case 0: { if(y>0) { break; } else { if(y<0) return 10; } } case 1: return 20; } return 30;",
    "switch(x) { case 0: if(y>0) return 10; case 1: if(y<0) return 20; } return 30;",
    "switch(x) { case 0: return 10; case 0: return 20; default: return 30; }",
    "switch(x) { case 0: if(y>0) break; case 0: return 20; default: return 30; } return 40;",
    "switch(x) { case y: return 10; case y+1: return 20; default: return 30; }",
    "switch(x+1) { case 1: return 10; case y: return 20; default: return 30; }",
    "switch(x) { case NaN: return 10; case -0: return 20; case Infinity: return 30; case -Infinity: return 40; default: return x; }",
    `switch(x) { case 0:
      switch(y) { case 0: break; case 1: return 10; default: if(y<0) break; return 20; }
      if(y===0) break;
      return 30;
      default: return 40;
    } return 50;`,
    `switch(x) { case 0:
      switch(y) { case 0: break; case 1: return 10; }
      if(y<0) break;
      case 1: return 20;
      default: return 30;
    } return 40;`,
    "if(y>0) { switch(x) { case 0: break; default: return 10; } return 20; } return 30;",
    "switch(x) { case 0: break; default: if(y>0) return 10; } switch(y) { case 0: return 20; default: return 30; }",
    "switch(x) { case 0: if(y>0) break; default: if(y<0) return 10; case 1: } return 20;",
  ];
  const source = bodies.map((body, i) => `function f${i}(x:number,y:number):number {${body}}
    contract(f${i}, { ensures: () => true });`).join("\n");
  const ir = adapt(fixture("differential-number", source));
  const pairs = ir.functions.map((fn, i) => ({
    native: new Function("x", "y", bodies[i]),
    lowered: new Function("x", "y", `return ${prettyExpr(fn.body)};`),
  }));
  const check = (x: number, y: number) => {
    for (const [i, { native, lowered }] of pairs.entries())
      expect(lowered(x, y), `body ${i}; x=${x}, y=${y}`).toBe(native(x, y));
  };
  const inputs = [-Infinity, -2, -1, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1, 2, Infinity, NaN];
  for (const x of inputs) for (const y of inputs) check(x, y);
  fc.assert(fc.property(fc.double(), fc.double(), check), { seed: 3517, numRuns: 200 });
});

test("bigint and UTF-16 switch comparisons preserve exact values", () => {
  const cases = [
    { name: "bigint", type: "bigint", body: `switch(x) {
      case -1n: return 1n;
      case 9007199254740993n: return 2n;
      case 0xffff_ffff_ffff_ffffn: return 3n;
      default: return 0n;
    }`, values: [-1n, 0n, 9007199254740992n, 9007199254740993n, 18446744073709551615n] },
    { name: "string", type: "string", body: `switch(x) {
      case "": return "empty";
      case "😀": return "pair";
      case "\\ud800": return "surrogate";
      case "é": return "composed";
      default: return x;
    }`, values: ["", "😀", "\ud800", "\udfff", "é", "e\u0301", "\0", "x"] },
  ];
  for (const { name, type, body, values } of cases) {
    const ir = adapt(fixture("differential-" + name, `function f(x:${type}):${type} {${body}}
      contract(f, { ensures: () => true });`));
    const native = new Function("x", body);
    const lowered = new Function("x", `return ${prettyExpr(ir.functions[0].body)};`);
    for (const x of values) expect(lowered(x)).toBe(native(x));
  }
  const ir = adapt(fixture("string-length", `function f(x:string):number {
    switch(x.length) { case "😀".length: return 1; default: return 0; }
  } contract(f, { ensures: r => r === 0 || r === 1 });`));
  const lowered = new Function("x", `return ${prettyExpr(ir.functions[0].body)};`);
  expect(lowered("😀")).toBe(1);
  expect(lowered("a")).toBe(0);
});

test("lowering rejects missing return paths and break without a switch target", () => {
  expect(() => returnExpression({ kind: "break" })).toThrow(/break outside switch/);
  expect(returnExpression({ kind: "switch", value: { kind: "number", value: encodeNumber(1) }, clauses: [
    { body: { kind: "break" } },
  ] })).toBeUndefined();
  expect(() => adapt(fixture("missing-return", `function f(x:number):number {
    switch(x) { case 0: return 1; default: break; }
  } contract(f, { ensures: () => true });`))).toThrow(/return/);
});

test("switch selection rejects calls, getters, mutations and labeled control flow", () => {
  const bodies = [
    "switch(cb()) {} return 0;",
    "switch(o.value) {} return 0;",
    'switch(o["value"]) {} return 0;',
    "switch(x++) {} return 0;",
    "switch(x=1) {} return 0;",
    "switch(x) { case cb(): return 1; } return 0;",
    "switch(x) { case o.value: return 1; } return 0;",
    "switch(x) { case x+cb(): return 1; } return 0;",
    "switch(x) { case ++x: return 1; } return 0;",
    "switch(x) { case x=1: return 1; } return 0;",
    "switch(o.label.length) { case 0: return 1; } return 0;",
    "outer: switch(x) { case 0: break outer; } return 0;",
  ];
  for (const [i, body] of bodies.entries()) {
    const entry = fixture("unsupported-" + i, `function f(x:number,o:{value:number,label:string},cb:()=>number):number {
      ${body}
    } contract(f, { ensures: () => true });`);
    expect(() => adapt(entry)).toThrowError(expect.objectContaining({ reasonCode: "unsupported-code" }));
  }
});

test("unsupported switch dependencies stay unknown without blocking independent predicates", async () => {
  const entry = fixture("unknown", `
function arithmetic(x:number):number { switch(x*x) { case 1: return 1; default: return 0; } }
contract(arithmetic, { requires:x=>x>=0, ensures:r=>r>=0 });
function label(x:number):number { switch(x) { case x*x: return 1; default: return 0; } }
contract(label, { requires:x=>x>=0, ensures:r=>r>=0 });
function opaque(flag:boolean,x:number):number { switch(flag) { case true: return x; default: return 0; } }
contract(opaque, { requires:(_flag,x)=>x>=0, ensures:r=>r>=0 });
function irrelevant(x:bigint,y:number):number { switch(x) { case 0n: return y; default: return 0; } }
contract(irrelevant, { requires:(_x,y)=>y>=0 });`);
  const report = await verify(entry);
  expect(report.status).toBe("unknown");
  expect(report.semantics).toBe("number-ieee754-binary64");
  expect(report.results.filter(r => r.kind === "preconditions").every(r => r.status === "satisfiable")).toBe(true);
  const implementations = report.results.filter(r => r.kind === "implementation");
  expect(implementations).toHaveLength(3);
  for (const result of implementations)
    expect(result).toMatchObject({ status: "unknown", reasonCode: "unsupported-dependency" });
  const mixed = await verify(fixture("mixed", `function f(x:bigint):number {
    switch(x) { case 0n: return 0; default: return 1; }
  } contract(f, { ensures:r=>r>=0 });`));
  expect(mixed).toMatchObject({ status: "unknown", reasonCode: "unsupported-numeric-model", results: [] });
});

test("solver verifies strict number and UTF-16 selection and native execution agrees", async () => {
  const entry = fixture("verified-scalars", `
function special(x:number):number {
  switch(x) { case NaN: return 99; case -0: return 1; case Infinity: return 2; default: return 3; }
}
contract(special, { ensures:(r,x)=>(x===0 && r===1) || (x===Infinity && r===2) || (x!==0 && x!==Infinity && r===3) });
function text(s:string):number {
  switch(s) { default: return 0; case "😀": return 1; case "\\ud800": return 2; }
}
contract(text, { ensures:(r,s)=>(s==="😀" && r===1) || (s==="\\ud800" && r===2) || (s!=="😀" && s!=="\\ud800" && r===0) });`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const x of [NaN, -0, 0, Infinity, -Infinity, 1])
    expect(runtime.execute("special", [x]).ensures).toBe(true);
  for (const s of ["😀", "\ud800", "\udfff", "", "e\u0301"])
    expect(runtime.execute("text", [s]).ensures).toBe(true);
});

test("shared switch continuations retain call identities, path guards and runtime contracts", async () => {
  const source = `function positive(x:bigint):bigint { return x; }
contract(positive, { requires:x=>x>0n, ensures:(r,x)=>r===x });
function caller(x:bigint):bigint {
  switch(x) {
    case 1n: if(x<1n) break;
    case 2n: return positive(x);
    case 0n: break;
    default: if(x<0n) return 0n; break;
  }
  return positive(x+1n);
}
contract(caller, { ensures:r=>r>=0n });`;
  const entry = fixture("calls", source);
  const ir = adapt(entry);
  expect(ir.coverage.calls).toHaveLength(2);
  const caller = ir.functions.find(fn => fn.sourceName === "caller")!;
  const paths = callPaths(caller.body);
  expect(paths).toHaveLength(5);
  expect(new Set(paths.map(p => p.call.id)).size).toBe(2);
  const input = fs.readFileSync(entry, "utf8");
  for (const { call } of paths) {
    expect(["positive(x)", "positive(x+1n)"]).toContain(input.slice(call.source.start, call.source.end));
    const copies = paths.filter(p => p.call.id === call.id);
    expect(copies.every(p => JSON.stringify(p.call) === JSON.stringify(call))).toBe(true);
  }
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  expect(report.results.filter(r => r.kind === "call")).toHaveLength(5);
  const runtime = createTestRuntime(entry);
  for (const x of [-2n, -1n, 0n, 1n, 2n, 3n]) {
    const execution = runtime.execute("caller", [x]);
    expect(execution.ensures).toBe(true);
    expect(execution.result).toBe(x < 0n ? 0n : x === 1n || x === 2n ? x : x + 1n);
  }
  const unsafeEntry = fixture("unsafe-call", source.replace("positive(x+1n)", "positive(x)"));
  const unsafe = await verify(unsafeEntry);
  expect(unsafe.status).toBe("refuted");
  expect(unsafe.results.find(r => r.kind === "call" && r.status === "disproved"))
    .toMatchObject({ counterexample: { x: "0n" } });
  const failed = createTestRuntime(unsafeEntry).execute("caller", [0n]);
  expect(failed.calls.some(call => !call.accepted)).toBe(true);
});

test("call coverage still rejects calls discarded after break", () => {
  const entry = fixture("dead-call", `function g(x:bigint):bigint { return x; }
contract(g, { ensures:(r,x)=>r===x });
function f(x:bigint):bigint { switch(x) { case 0n: break; return g(x); } return 1n; }
contract(f, { ensures:r=>r===1n });`);
  expect(() => adapt(entry)).toThrow(/call coverage changed/);
});

test("wrong nested switch implementation produces a replayable counterexample", async () => {
  const entry = fixture("refuted", `function f(x:bigint,y:bigint):bigint {
    switch(x) { case 0n: switch(y) { case 1n: break; default: return 0n; }
      return 2n; default: return 0n; }
  } contract(f, { ensures:r=>r===0n });`);
  const report = await verify(entry);
  expect(report.status).toBe("refuted");
  const result = report.results.find(r => r.kind === "implementation" && r.status === "disproved");
  expect(result).toMatchObject({ counterexample: { x: "0n", y: "1n" } });
  if (result?.status !== "disproved") throw new Error("missing counterexample");
  const args = ["x", "y"].map(name => BigInt((result.counterexample[name] as string).slice(0, -1)));
  expect(createTestRuntime(entry).execute("f", args).ensures).toBe(false);
});

test("CLI verifies switch and reports forbidden selection with an input diagnostic", () => {
  const good = fixture("cli-good", `function f(x:bigint):bigint {
    switch(x) { case 1n: return 1n; default: return 0n; }
  } contract(f, { ensures:r=>r>=0n });`);
  const bad = fixture("cli-bad", `function f(x:bigint):bigint {
    switch(x++) {} return x;
  } contract(f, { ensures:()=>true });`);
  for (const [entry, status, code] of [[good, "verified", 0], [bad, "unknown", 2]] as const) {
    const run = spawnSync(process.execPath, [path.resolve("scripts/verify.ts"), entry], {
      cwd: path.dirname(entry), encoding: "utf8", timeout: 60000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(code);
    const report = JSON.parse(run.stdout);
    expect(report.status).toBe(status);
    if (code === 2) expect(report).toMatchObject({ reasonCode: "unsupported-code", source: { file: entry } });
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "work/verification.json"), "utf8"))).toEqual(report);
  }
});
