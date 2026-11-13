import { dependencies } from "./dependencies.ts";
import { init, type Z3_ast } from "z3-solver";
import type { ProgramIR } from "./ir.ts";
import { numericSort, validateIR } from "./ir-integrity.ts";
import { decodeNumber, encodeNumber, type EncodedValue } from "./numeric-values.ts";
import { verifyWithModel, type NumericModel, type SolverLimits } from "./verification-engine.ts";

type Term = { ast: Z3_ast; sort: "number" | "boolean" | "string";
  // Exact integer view only for safe integers. Bounds are conservative.
  integer?: Z3_ast; min?: bigint; max?: bigint; noNegativeZero?: boolean;
  minLength?: bigint; maxLength?: bigint };
const MAX_LENGTH = 9007199254740991n;
const MAX_COUNTEREXAMPLE_LENGTH = 65536;
let initialized: ReturnType<typeof init> | undefined;

/** Each run owns a non-RC AST context. Solver/model/params references have
 * independent lifetimes; no term can be used after the callback finishes. */
export async function withNumberModel<T>(run: (model: NumericModel<Term> & {
  read(term: Term): Promise<number | boolean | string>;
  sameTerm(a: Term, b: Term): Term;
}) => Promise<T>): Promise<T> {
  const { Z3: z } = await (initialized ??= init());
  const config = z.mk_config();
  const c = z.mk_context(config);
  z.del_config(config);
  let active = true;
  const alive = () => { if (!active) throw new Error("Number context has been released"); };
  try {
    const fp = z.mk_fpa_sort_64(c), bv = z.mk_bv_sort(c, 64), rne = z.mk_fpa_rne(c);
    const int = z.mk_int_sort(c), unit = z.mk_bv_sort(c, 16), seq = z.mk_seq_sort(c, unit);
    const integer = (value: bigint | number) => z.mk_numeral(c, String(value), int);
    const domains: Z3_ast[] = [];
    const term = (ast: Z3_ast, sort: Term["sort"]): Term => ({ ast, sort });
    const boolean = (value: Term) => { alive(); if (value.sort !== "boolean") throw new Error("Expected boolean term"); return value; };
    const numeric = (value: Term) => { alive(); if (value.sort !== "number") throw new Error("Expected number term"); return value; };
    const string = (value: Term) => { alive(); if (value.sort !== "string") throw new Error("Expected string term"); return value; };
    const fromInteger = (ast: Z3_ast, min: bigint, max: bigint): Term => ({
      ...term(z.mk_fpa_to_fp_real(c, rne, z.mk_int2real(c, ast), fp), "number"),
      ...(min >= -MAX_LENGTH && max <= MAX_LENGTH ? { integer: ast, min, max, noNegativeZero:true } : {}),
    });
    const binary = (op: (a: Z3_ast, b: Z3_ast) => Z3_ast, sort: Term["sort"]) =>
      (a: Term, b: Term) => term(op(numeric(a).ast, numeric(b).ast), sort);
    const decode = async (ast: Z3_ast): Promise<number> => {
      alive();
      const value = await z.simplify(c, ast);
      if (z.fpa_is_numeral_nan(c, value)) return NaN;
      const bits = await z.simplify(c, z.mk_fpa_to_ieee_bv(c, value));
      return decodeNumber({kind:"number", bits:BigInt(z.get_numeral_string(c, bits)).toString(16).padStart(16, "0")});
    };
    const compare = (ints: (a: Z3_ast,b: Z3_ast) => Z3_ast, floats: (a: Z3_ast,b: Z3_ast) => Z3_ast) =>
      (a: Term,b: Term): Term => { numeric(a); numeric(b); return term(a.integer && b.integer
        ? ints(a.integer,b.integer) : floats(a.ast,b.ast), "boolean"); };
    const readString = async (ast: Z3_ast, evaluate: (ast: Z3_ast) => Z3_ast): Promise<string | undefined> => {
      const size = BigInt(z.get_numeral_string(c, await z.simplify(c, evaluate(z.mk_seq_length(c,ast)))));
      if (size < 0n || size > BigInt(MAX_COUNTEREXAMPLE_LENGTH)) return undefined;
      const units: number[] = [];
      for (let i = 0; i < Number(size); i++) {
        const code = Number(z.get_numeral_string(c, await z.simplify(c, evaluate(z.mk_seq_nth(c,ast,integer(i))))));
        if (!Number.isInteger(code) || code < 0 || code > 65535) throw new Error("Invalid UTF-16 model unit");
        units.push(code);
      }
      return units.map(code => String.fromCharCode(code)).join("");
    };
    const model: NumericModel<Term> & { read(term: Term): Promise<number | boolean | string>; sameTerm(a: Term,b: Term): Term } = {
      sort: "float64", boolean, numeric,
      supports: sort => sort === "float64" || sort === "string",
      length(value) { const v = string(value); return fromInteger(z.mk_seq_length(c,v.ast), v.minLength!, v.maxLength!); },
      literal(expr) {
        alive();
        if (expr.kind === "string") {
          const units = Array.from({length:expr.value.length}, (_,i) => z.mk_seq_unit(c,z.mk_numeral(c,String(expr.value.charCodeAt(i)),unit)));
          return { ...term(units.length ? z.mk_seq_concat(c,units) : z.mk_seq_empty(c,seq), "string"), minLength:BigInt(units.length), maxLength:BigInt(units.length) };
        }
        if (expr.kind !== "number") throw new Error("Expected number literal");
        const value = decodeNumber(expr.value);
        const result = term("special" in expr.value ? z.mk_fpa_nan(c, fp)
          : z.mk_fpa_to_fp_bv(c, z.mk_numeral(c, BigInt("0x" + expr.value.bits).toString(), bv), fp), "number");
        return Number.isSafeInteger(value) ? {...result, integer:integer(BigInt(value)), min:BigInt(value),max:BigInt(value),noNegativeZero:!Object.is(value,-0)} : result;
      },
      variable(name, sort = "float64") {
        alive();
        if (sort === "string") {
          const ast = z.mk_const(c,z.mk_string_symbol(c,name),seq);
          domains.push(z.mk_le(c,z.mk_seq_length(c,ast),integer(MAX_LENGTH)));
          return {...term(ast,"string"),minLength:0n,maxLength:MAX_LENGTH};
        }
        if (sort !== "float64") throw new Error("Unsupported variable sort");
        return term(z.mk_const(c, z.mk_string_symbol(c, name), fp), "number");
      },
      truth(value) { alive(); return term(value ? z.mk_true(c) : z.mk_false(c), "boolean"); },
      neg: value => term(z.mk_fpa_neg(c, numeric(value).ast), "number"),
      add(a,b) {
        if (a.sort === "string") return {...term(z.mk_seq_concat(c,[a.ast,string(b).ast]),"string"),
          minLength:a.minLength!+b.minLength!,maxLength:a.maxLength!+b.maxLength!};
        numeric(a); numeric(b);
        // For nonnegative exact integers this is one correctly rounded sum.
        // No signed-zero distinction is lost because this shortcut excludes -0.
        if (a.integer && b.integer && a.min! >= 0n && b.min! >= 0n && a.noNegativeZero && b.noNegativeZero)
          return fromInteger(z.mk_add(c,[a.integer,b.integer]),a.min!+b.min!,a.max!+b.max!);
        return term(z.mk_fpa_add(c,rne,a.ast,b.ast),"number");
      },
      sub: binary((a,b) => z.mk_fpa_sub(c,rne,a,b), "number"),
      mul: binary((a,b) => z.mk_fpa_mul(c,rne,a,b), "number"),
      div: binary((a,b) => z.mk_fpa_div(c,rne,a,b), "number"),
      lt: compare((a,b) => z.mk_lt(c,a,b), (a,b) => z.mk_fpa_lt(c,a,b)),
      le: compare((a,b) => z.mk_le(c,a,b), (a,b) => z.mk_fpa_leq(c,a,b)),
      gt: compare((a,b) => z.mk_gt(c,a,b), (a,b) => z.mk_fpa_gt(c,a,b)),
      ge: compare((a,b) => z.mk_ge(c,a,b), (a,b) => z.mk_fpa_geq(c,a,b)),
      eq(a,b) {
        alive(); if (a.sort !== b.sort) throw new Error("Mismatched equality sorts");
        if (a.sort !== "number") return term(z.mk_eq(c,a.ast,b.ast),"boolean");
        return compare((x,y)=>z.mk_eq(c,x,y),(x,y)=>z.mk_fpa_eq(c,x,y))(a,b);
      },
      Not: value => term(z.mk_not(c,boolean(value).ast), "boolean"),
      And: (...args) => term(z.mk_and(c,args.map(a => boolean(a).ast)), "boolean"),
      Or: (...args) => term(z.mk_or(c,args.map(a => boolean(a).ast)), "boolean"),
      Implies: (a,b) => term(z.mk_implies(c,boolean(a).ast,boolean(b).ast), "boolean"),
      If(a,b,d) {
        alive(); if (b.sort !== d.sort) throw new Error("Mismatched branch sorts");
        return {...term(z.mk_ite(c,boolean(a).ast,b.ast,d.ast),b.sort),
          ...(b.sort === "string" ? {
            minLength:b.minLength! < d.minLength! ? b.minLength : d.minLength,
            maxLength:b.maxLength! > d.maxLength! ? b.maxLength : d.maxLength,
          } : {})};
      },
      sameTerm(a,b) { alive(); if (a.sort !== b.sort) throw new Error("Mismatched term sorts"); return term(z.mk_eq(c,a.ast,b.ast), "boolean"); },
      async read(value) {
        alive();
        if (value.sort === "number") return decode(value.ast);
        if (value.sort === "string") {
          const result = await readString(value.ast, ast => ast);
          if (result === undefined) throw new Error("String exceeds decoding limit");
          return result;
        }
        const result = z.get_bool_value(c, await z.simplify(c,value.ast));
        if (result === 0) throw new Error("Not a concrete boolean");
        return result === 1;
      },
      async solve(assumptions, variables, limits) {
        alive();
        const solver = z.mk_solver(c); z.solver_inc_ref(c,solver);
        try {
          const params = z.mk_params(c); z.params_inc_ref(c,params);
          try {
            z.params_set_uint(c,params,z.mk_string_symbol(c,"timeout"),limits.timeoutMs ?? 5000);
            if (limits.resourceLimit !== undefined) z.params_set_uint(c,params,z.mk_string_symbol(c,"rlimit"),limits.resourceLimit);
            z.solver_set_params(c,solver,params);
          } finally { z.params_dec_ref(c,params); }
          for (const domain of domains) z.solver_assert(c,solver,domain);
          for (const assumption of assumptions) z.solver_assert(c,solver,boolean(assumption).ast);
          const status = await z.solver_check(c,solver);
          if (status === -1) return {status:"unsat"};
          if (status === 0) return {status:"unknown", reason:z.solver_get_reason_unknown(c,solver)};
          const result = z.solver_get_model(c,solver); z.model_inc_ref(c,result);
          try {
            const counterexample: Record<string, EncodedValue> = Object.create(null);
            for (const [name, variable] of variables) {
              if (variable.sort === "string") {
                // Query length before materializing the sequence itself. A large
                // model must never be expanded just to decide that it is too large.
                const decoded = variable.minLength! > BigInt(MAX_COUNTEREXAMPLE_LENGTH) ? undefined : await readString(variable.ast, ast => {
                  const evaluated = z.model_eval(c,result,ast,true);
                  if (!evaluated) throw new Error("Missing string model value");
                  return evaluated;
                });
                if (decoded === undefined) return {status:"unknown",reason:"String counterexample exceeds decoding limit (65536 UTF-16 units)"};
                counterexample[name] = {kind:"string",value:decoded};
              } else {
                const value = z.model_eval(c,result,numeric(variable).ast,true);
                if (!value) throw new Error("Missing number model value");
                counterexample[name] = encodeNumber(await decode(value));
              }
            }
            return {status:"sat", counterexample};
          } finally { z.model_dec_ref(c,result); }
        } finally { z.solver_dec_ref(c,solver); }
      },
    };
    return await run(model);
  } finally { active = false; z.del_context(c); }
}

export async function verifyNumbers(program: ProgramIR, limits: SolverLimits = {}) {
  validateIR(program);
  if (numericSort(program) !== "float64" && dependencies(program).sorts.size) throw new Error("Number backend requires float64 IR");
  return withNumberModel(model => verifyWithModel(program, model, limits));
}
