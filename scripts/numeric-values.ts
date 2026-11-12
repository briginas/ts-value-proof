/** Exact transport values; JavaScript JSON numbers cannot preserve -0 or NaN. */
export type Numeric = bigint | number;
export type Scalar = Numeric | string;
export type ScalarSort = NumericSort | "string";
export type StringValue = { kind: "string"; value: string };
export type NumberValue = { kind: "number"; bits: string } | { kind: "number"; special: "NaN" };
export type EncodedValue = string | NumberValue | StringValue;
export type NumericSort = "int" | "float64";
export type Semantics = "bigint-exact-integers" | "number-ieee754-binary64" | "string-utf16-number-binary64";
export const semanticsFor = (sort: ScalarSort): Semantics =>
  sort === "string" ? "string-utf16-number-binary64" : sort === "int" ? "bigint-exact-integers" : "number-ieee754-binary64";
export const runtimeType = (sort: ScalarSort): "bigint" | "number" | "string" => sort === "string" ? "string" : sort === "int" ? "bigint" : "number";

export function encodeNumber(value: number): NumberValue {
  if (Number.isNaN(value)) return { kind: "number", special: "NaN" };
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return { kind: "number", bits: buffer.toString("hex") };
}
export function decodeNumber(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid number encoding");
  const fields = Object.keys(value);
  const object = value as Record<string, unknown>;
  if (fields.length !== 2 || !fields.includes("kind") || object.kind !== "number") throw new Error("Invalid number encoding");
  if (fields.includes("special") && object.special === "NaN") return NaN;
  if (fields.includes("bits") && typeof object.bits === "string" && /^[0-9a-f]{16}$/.test(object.bits)) {
    const result = Buffer.from(object.bits, "hex").readDoubleBE();
    if (!Number.isNaN(result)) return result;
  }
  throw new Error("Invalid number encoding");
}
export function encodeNumeric(value: Numeric): EncodedValue {
  return typeof value === "bigint" ? value.toString() + "n" : encodeNumber(value);
}
export function decodeNumeric(value: unknown, sort: NumericSort): Numeric {
  if (sort === "float64") return decodeNumber(value);
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)n$/.test(value)) throw new Error("Invalid bigint encoding");
  return BigInt(value.slice(0, -1));
}
export function formatNumeric(value: Numeric): string {
  return typeof value === "bigint" ? value + "n" : Object.is(value, -0) ? "-0" : String(value);
}

export function encodeScalar(value: Scalar): EncodedValue {
  return typeof value === "string" ? { kind: "string", value } : encodeNumeric(value);
}
export function decodeScalar(value: unknown, sort: ScalarSort): Scalar {
  if (sort !== "string") return decodeNumeric(value, sort);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid string encoding");
  const object = value as Record<string, unknown>;
  const fields = Object.keys(object);
  if (fields.length !== 2 || !fields.includes("kind") || !fields.includes("value") ||
      object.kind !== "string" || typeof object.value !== "string")
    throw new Error("Invalid string encoding");
  return object.value;
}
