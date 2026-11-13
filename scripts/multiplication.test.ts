import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adapt } from "./adapter.ts";
import { prettyExpr } from "./ir.ts";
import { sourceInventory, validateIR } from "./ir-integrity.ts";
import { verify } from "./verify.ts";
import { createTestRuntime } from "./test-runtime.ts";
import { checkProperties } from "./property-tests.ts";
import { generateRegressions, loadRegressions, replayRegression } from "./regressions.ts";

function fixture(name: string, source: string) {
  const directory = path.resolve("work/multiplication", name);
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, "entry.ts");
  const api = path.relative(directory, path.resolve("src/contract.js")).split(path.sep).join("/");
  fs.writeFileSync(entry, `import {contract} from ${JSON.stringify(api)};\n${source}`);
  return entry;
}

test("bigint products preserve precedence, signs and nonlinear contracts", async () => {
  const entry = fixture("bigint", `
function square(x:bigint):bigint{return x*x;}
contract(square,{ensures:r=>r>=0n});
function product(x:bigint,y:bigint):bigint{return x*y;}
contract(product,{requires:(x,y)=>x*y>=0n,ensures:r=>r>=0n});
function precedence(x:bigint,y:bigint):bigint{return x+y*2n;}
contract(precedence,{ensures:(r,x,y)=>r===x+(y+y)});
function grouped(x:bigint,y:bigint):bigint{return (x+y)*2n;}
contract(grouped,{ensures:(r,x,y)=>r===x+x+y+y});
function nested(x:bigint,y:bigint):bigint{return -(x*y)*3n;}
contract(nested,{ensures:(r,x,y)=>r===-3n*x*y});`);
  const report = await verify(entry);
  expect(report.status, JSON.stringify(report)).toBe("verified");
  const runtime = createTestRuntime(entry);
  const huge = 123456789012345678901234567890123456789n;
  for (const x of [0n, 1n, -1n, huge, -huge]) {
    expect(runtime.execute("square", [x])).toMatchObject({ result: x*x, ensures: true });
    expect(runtime.execute("product", [x, x])).toMatchObject({ result: x*x, ensures: true });
  }
  expect(prettyExpr(runtime.ir.functions.find(f => f.name === "precedence")!.body)).toBe("(x + (y * 2n))");
  expect((await checkProperties(runtime, { seed: 42, numRuns: 20 })).every(r => r.status === "passed")).toBe(true);
});

test("multiplication in guards, call arguments and modular postconditions", async () => {
  const entry = fixture("calls", `
function nonnegative(x:bigint):bigint{return x;}
contract(nonnegative,{requires:x=>x>=0n,ensures:(r,x)=>r===x});
function guarded(x:bigint,y:bigint):bigint{if(x*y<0n)return 0n;return nonnegative(x*y);}
contract(guarded,{ensures:r=>r>=0n});
function double(x:bigint):bigint{return x*2n;}
contract(double,{ensures:(r,x)=>r===x*2n});
function caller(x:bigint):bigint{return double(x)*3n;}
contract(caller,{ensures:(r,x)=>r===x*6n});
function unsafe(x:bigint):bigint{return nonnegative(x*2n);}`);
  const report = await verify(entry);
  expect(report.status).toBe("refuted");
  expect(report.results.filter(r => r.function !== "unsafe").every(r => r.status === "proved" || r.status === "satisfiable")).toBe(true);
  const bad = report.results.find(r => r.function === "unsafe" && r.kind === "call");
  expect(bad?.status).toBe("disproved");
  if (bad?.status !== "disproved") throw new Error("Expected concrete call violation");
  const x = BigInt((bad.counterexample.x as string).slice(0, -1));
  expect(createTestRuntime(entry).execute("unsafe", [x]).calls[0].accepted).toBe(false);
});

test("number products match native JS through source, solver and runtime", async () => {
  const cases: [string, string, number, number][] = [
    ["0.1", "0.2", 0.1, 0.2], ["1e308", "2", 1e308, 2],
    ["0", "Infinity", 0, Infinity], ["NaN", "1", NaN, 1],
    ["-0", "-1", -0, -1], ["0", "-1", 0, -1],
    ["5e-324", "0.5", Number.MIN_VALUE, 0.5],
    ["-5e-324", "0.5", -Number.MIN_VALUE, 0.5],
    ["1.5e-323", "0.5", 3*Number.MIN_VALUE, 0.5],
  ];
  const source = cases.map(([a, b, x, y], i) => {
    const expected = x*y;
    return `function f${i}():number{return ${a}*${b};}
contract(f${i},{ensures:r=>${Number.isNaN(expected) ? "r!==r" : `r===${String(expected)}`}});`;
  }).join("\n");
  const entry = fixture("numbers", source);
  expect((await verify(entry)).status).toBe("verified");
  const runtime = createTestRuntime(entry);
  for (const [i, [, , x, y]] of cases.entries())
    expect(Object.is(runtime.execute("f"+i, []).result, x*y)).toBe(true);
});

test("number multiplication in predicates and string length expressions", async () => {
  const entry = fixture("number-predicates", `
function product(x:number):number{return x*2;}
contract(product,{requires:x=>x===3 && x*2===6,ensures:r=>r===6});
function length(s:string):number{return s.length*2;}
contract(length,{requires:s=>s==="😀",ensures:r=>r===4});`);
  expect((await verify(entry)).status).toBe("verified");
});

test("incorrect products generate exact, replayable bigint and number regressions", async () => {
  for (const [name, source] of [
    ["bigint", `function f(x:bigint):bigint{return x*x;}
contract(f,{requires:x=>x===900719925474099312345n,ensures:r=>r===0n});`],
    ["number", `function f(x:number):number{return x*0;}
contract(f,{ensures:r=>r===0});`],
    ["rounding", `function f(x:number):number{return x*0.2;}
contract(f,{requires:x=>x===0.1,ensures:r=>r===0.02});`],
  ]) {
    const entry = fixture("regression-"+name, source);
    const generated = await generateRegressions(entry, path.join(path.dirname(entry), "generated"));
    expect(generated.unconfirmed).toEqual([]);
    expect(generated.cases).toBe(1);
    const { manifest, runtime } = loadRegressions(generated.manifestFile);
    expect(replayRegression(runtime, entry, manifest.cases[0]).status).toBe("failed");
    if (name === "bigint") expect(manifest.cases[0].inputs).toEqual(["900719925474099312345n"]);
  }
});

test("multiplication preserves solver resource limits", async () => {
  for (const type of ["bigint", "number"]) {
    const zero = type === "bigint" ? "0n" : "0";
    const entry = fixture("limits-"+type, `function f(x:${type}):${type}{return x*x;}
contract(f,{ensures:r=>r>=${zero}});`);
    const report = await verify(entry, { resourceLimit: 1 });
    expect(report.status).toBe("unknown");
    expect(report.results[0]).toMatchObject({ status: "unknown", reasonCode: "solver-unknown" });
    expect(report.results[0]).not.toHaveProperty("counterexample");
  }
});

test("multiplication rejects invalid source and IR operand sorts", async () => {
  for (const [name, params] of [["mixed", "x:bigint,y:number"], ["string", "x:string,y:string"], ["boolean", "x:boolean,y:boolean"]]) {
    const entry = fixture("invalid-"+name, `function f(${params}):number{return x*y;}
contract(f,{ensures:r=>r===0});`);
    await expect(verify(entry)).rejects.toMatchObject({ reasonCode: "type-error" });
  }
  const entry = fixture("ir-sorts", `function f(x:number,y:number):number{return x*y;}
contract(f,{ensures:r=>r===0});`);
  for (const sort of ["int", "string"] as const) {
    const ir = adapt(entry);
    ir.functions[0].params[0].sort = sort;
    ir.coverage.inventory = sourceInventory(ir);
    expect(() => validateIR(ir)).toThrow(/Invalid IR/);
  }
});
