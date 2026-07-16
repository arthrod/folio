/**
 * Deep-diff utility for the legacy-vs-jubarte parse parity harness.
 * Reports human-readable path-anchored differences between two Document
 * models. Maps, arrays, ArrayBuffers, and plain objects are compared
 * structurally; `undefined` properties equal missing properties; functions
 * and the `originalBuffer` backreference are skipped.
 */

export type ParityDiffOptions = {
  /** Property names ignored everywhere (e.g. warnings). */
  ignoreKeys?: ReadonlySet<string>;
  /** Maximum differences to collect before stopping. */
  limit?: number;
};

export function diffDocuments(
  legacy: unknown,
  jubarte: unknown,
  options: ParityDiffOptions = {},
): string[] {
  const out: string[] = [];
  const ignore = options.ignoreKeys ?? new Set(["originalBuffer", "warnings"]);
  const limit = options.limit ?? 80;
  walk(legacy, jubarte, "$", out, ignore, limit, new Set());
  return out;
}

function walk(
  a: unknown,
  b: unknown,
  path: string,
  out: string[],
  ignore: ReadonlySet<string>,
  limit: number,
  seen: Set<unknown>,
): void {
  if (out.length >= limit) {
    return;
  }
  if (Object.is(a, b)) {
    return;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    out.push(`${path}: legacy=${brief(a)} jubarte=${brief(b)}`);
    return;
  }
  if (typeof a !== typeof b) {
    out.push(`${path}: type legacy=${typeName(a)} jubarte=${typeName(b)}`);
    return;
  }
  if (typeof a === "function") {
    return;
  }
  if (typeof a !== "object") {
    out.push(`${path}: legacy=${brief(a)} jubarte=${brief(b)}`);
    return;
  }
  if (seen.has(a)) {
    return;
  }
  seen.add(a);

  if (a instanceof ArrayBuffer || ArrayBuffer.isView(a)) {
    const ua = toU8(a);
    const ub = b instanceof ArrayBuffer || ArrayBuffer.isView(b) ? toU8(b) : null;
    if (!ub || ua.length !== ub.length || !ua.every((v, i) => v === ub[i])) {
      out.push(`${path}: binary differs (legacy ${ua.length}B, jubarte ${ub?.length ?? "?"}B)`);
    }
    return;
  }

  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map)) {
      out.push(`${path}: type legacy=${typeName(a)} jubarte=${typeName(b)}`);
      return;
    }
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (out.length >= limit) {
        return;
      }
      if (!a.has(key)) {
        out.push(`${path}[${String(key)}]: missing in legacy`);
      } else if (!b.has(key)) {
        out.push(`${path}[${String(key)}]: missing in jubarte`);
      } else {
        walk(a.get(key), b.get(key), `${path}[${String(key)}]`, out, ignore, limit, seen);
      }
    }
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${path}: type legacy=${typeName(a)} jubarte=${typeName(b)}`);
      return;
    }
    if (a.length !== b.length) {
      out.push(
        `${path}: length legacy=${a.length} jubarte=${b.length}` +
          ` (first legacy item: ${brief(a[Math.min(a.length, b.length)])},` +
          ` first jubarte item: ${brief(b[Math.min(a.length, b.length)])})`,
      );
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (out.length >= limit) {
        return;
      }
      walk(a[i], b[i], `${path}[${i}]`, out, ignore, limit, seen);
    }
    return;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (out.length >= limit) {
      return;
    }
    if (ignore.has(key)) {
      continue;
    }
    const av = ao[key];
    const bv = bo[key];
    if (av === undefined && bv === undefined) {
      continue;
    }
    if (typeof av === "function" || typeof bv === "function") {
      continue;
    }
    walk(av, bv, `${path}.${key}`, out, ignore, limit, seen);
  }
}

function toU8(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value instanceof Map) {
    return "Map";
  }
  if (value instanceof ArrayBuffer) {
    return "ArrayBuffer";
  }
  return typeof value;
}

function brief(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value instanceof Map) {
    return `Map(${value.size})`;
  }
  const obj = value as Record<string, unknown>;
  const type = typeof obj["type"] === "string" ? `type=${obj["type"]} ` : "";
  return `{${type}keys=${Object.keys(obj).slice(0, 6).join(",")}}`;
}
