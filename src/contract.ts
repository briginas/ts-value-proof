type AnyFunction = (...args: never[]) => unknown;

// Keep the signature invariant even when only one predicate is present.
type Predicates<in out F extends AnyFunction> = {
  readonly requires?: (...args: Parameters<F>) => boolean;
  readonly ensures?: (result: ReturnType<F>, ...args: Parameters<F>) => boolean;
};
export type Specification<F extends AnyFunction> = Predicates<F> & (
  | { readonly requires: (...args: Parameters<F>) => boolean }
  | { readonly ensures: (result: ReturnType<F>, ...args: Parameters<F>) => boolean }
);

export type BoundContract<F extends AnyFunction> = {
  readonly fn: F;
  readonly specification: Specification<F>;
};

/** Describes a contract. Does not execute predicates or verify anything at runtime. */
export function contract<F extends AnyFunction>(
  fn: F,
  specification: NoInfer<Specification<F>>,
): BoundContract<F> {
  return { fn, specification };
}
