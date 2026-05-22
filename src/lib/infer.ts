import type { ColumnSchema, ConvexType, TableSchema } from "./ir.js";

export interface InferOptions {
  /** Max documents to read for type inference. Default 1000. */
  sampleSize?: number;
}

const DEFAULT_SAMPLE = 1000;

/** Observe a single JSON value and produce its narrowest ConvexType. */
function observe(value: unknown): ConvexType {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    let element: ConvexType = { kind: "any" };
    let first = true;
    for (const item of value) {
      const t = observe(item);
      element = first ? t : merge(element, t);
      first = false;
    }
    return { kind: "array", element };
  }
  if (typeof value === "object") {
    const fields: Record<string, ConvexType> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = observe(v);
    }
    return { kind: "object", fields };
  }
  // bigint, function, symbol, undefined — shouldn't appear in parsed JSON
  return { kind: "any" };
}

/** Combine two observed types into the narrowest type that covers both. */
export function merge(a: ConvexType, b: ConvexType): ConvexType {
  if (a.kind === "any") return b;
  if (b.kind === "any") return a;
  if (a.kind === b.kind) return mergeSameKind(a, b);
  return normalizeUnion([a, b]);
}

function mergeSameKind(a: ConvexType, b: ConvexType): ConvexType {
  switch (a.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "bytes":
      return a;
    case "array":
      return {
        kind: "array",
        element: merge(a.element, (b as typeof a).element),
      };
    case "object":
      return mergeObjects(a, b as typeof a);
    case "union":
      return normalizeUnion([...a.members, ...(b as typeof a).members]);
    case "any":
      return a;
  }
}

function mergeObjects(
  a: Extract<ConvexType, { kind: "object" }>,
  b: Extract<ConvexType, { kind: "object" }>,
): ConvexType {
  const fields: Record<string, ConvexType> = {};
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const k of keys) {
    const av = a.fields[k];
    const bv = b.fields[k];
    if (av && bv) {
      fields[k] = merge(av, bv);
    } else {
      // Field appears in only one branch → treat as nullable (union with null).
      const present = av ?? bv;
      if (!present) continue;
      fields[k] =
        present.kind === "union" &&
        present.members.some((m) => m.kind === "null")
          ? present
          : normalizeUnion([present, { kind: "null" }]);
    }
  }
  return { kind: "object", fields };
}

function normalizeUnion(members: ConvexType[]): ConvexType {
  // Flatten nested unions, then dedupe by structural identity. Object/array
  // members of the same kind collapse via recursive merge so we don't end up
  // with parallel object shapes in one union.
  const flat: ConvexType[] = [];
  for (const m of members) {
    if (m.kind === "union") flat.push(...m.members);
    else flat.push(m);
  }

  let merged: ConvexType[] = [];
  for (const m of flat) {
    const idx = merged.findIndex((x) => x.kind === m.kind);
    if (idx === -1) {
      merged.push(m);
    } else {
      const existing = merged[idx];
      if (!existing) continue;
      merged[idx] = merge(existing, m);
    }
  }

  // Collapse the trivial cases.
  merged = merged.filter((m) => m.kind !== "any");
  if (merged.length === 0) return { kind: "any" };
  if (merged.length === 1) return merged[0]!;
  return { kind: "union", members: merged };
}

interface FieldState {
  type: ConvexType;
  presentIn: number;
}

function buildColumns(
  fields: Map<string, FieldState>,
  sampled: number,
): ColumnSchema[] {
  const isNullable = (t: ConvexType): boolean =>
    t.kind === "null" ||
    (t.kind === "union" && t.members.some((m) => m.kind === "null"));
  return [...fields.entries()]
    .map(
      ([name, state]): ColumnSchema => ({
        name,
        type: state.type,
        nullable: sampled - state.presentIn > 0 || isNullable(state.type),
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold a stream of documents (each a Convex top-level JSON object) into a
 * TableSchema. Pulls at most `sampleSize` docs from the iterator.
 */
export async function inferTableSchema(
  table: { path: string; name: string; system: boolean },
  docs: AsyncIterable<unknown>,
  opts: InferOptions = {},
): Promise<TableSchema> {
  const cap = opts.sampleSize ?? DEFAULT_SAMPLE;
  const fields = new Map<string, FieldState>();
  let sampled = 0;
  let truncated = false;

  for await (const doc of docs) {
    if (sampled >= cap) {
      truncated = true;
      break;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      // Should not happen for Convex docs; skip rather than crash inference.
      sampled++;
      continue;
    }
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      const observed = observe(value);
      const prev = fields.get(key);
      if (prev) {
        fields.set(key, {
          type: merge(prev.type, observed),
          presentIn: prev.presentIn + 1,
        });
      } else {
        fields.set(key, { type: observed, presentIn: 1 });
      }
    }
    sampled++;
  }

  const columns = buildColumns(fields, sampled);

  return {
    path: table.path,
    name: table.name,
    system: table.system,
    columns,
    sampled,
    truncated,
  };
}
