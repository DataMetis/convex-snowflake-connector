import { describe, expect, it } from "vitest";
import { inferTableSchema, merge as mergeT } from "../src/lib/infer.js";
import type { ConvexType } from "../src/lib/ir.js";

function fromArray<T>(xs: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next: () =>
          Promise.resolve(
            i < xs.length
              ? { value: xs[i++] as T, done: false }
              : { value: undefined as unknown as T, done: true },
          ),
      };
    },
  };
}

const t = {
  string: { kind: "string" } as ConvexType,
  number: { kind: "number" } as ConvexType,
  null_: { kind: "null" } as ConvexType,
  any: { kind: "any" } as ConvexType,
};

describe("merge", () => {
  it("collapses identical primitives", () => {
    expect(mergeT(t.string, t.string)).toEqual(t.string);
    expect(mergeT(t.number, t.number)).toEqual(t.number);
  });

  it("widens distinct primitives into a union", () => {
    expect(mergeT(t.string, t.number)).toEqual({
      kind: "union",
      members: [t.string, t.number],
    });
  });

  it("merges array elements pointwise", () => {
    const a: ConvexType = { kind: "array", element: t.string };
    const b: ConvexType = { kind: "array", element: t.null_ };
    expect(mergeT(a, b)).toEqual({
      kind: "array",
      element: { kind: "union", members: [t.string, t.null_] },
    });
  });

  it("merges objects, marking missing fields nullable", () => {
    const a: ConvexType = {
      kind: "object",
      fields: { x: t.string, y: t.number },
    };
    const b: ConvexType = { kind: "object", fields: { x: t.string } };
    const out = mergeT(a, b);
    expect(out.kind).toBe("object");
    if (out.kind !== "object") throw new Error();
    expect(out.fields.x).toEqual(t.string);
    expect(out.fields.y).toEqual({
      kind: "union",
      members: [t.number, t.null_],
    });
  });

  it("flattens nested unions", () => {
    const u: ConvexType = { kind: "union", members: [t.string, t.number] };
    const out = mergeT(u, { kind: "boolean" });
    expect(out).toEqual({
      kind: "union",
      members: [t.string, t.number, { kind: "boolean" }],
    });
  });

  it("treats `any` as identity", () => {
    expect(mergeT(t.any, t.string)).toEqual(t.string);
    expect(mergeT(t.number, t.any)).toEqual(t.number);
  });
});

describe("inferTableSchema", () => {
  const tbl = { path: "users", name: "users", system: false };

  it("infers a simple uniform table", async () => {
    const docs = [
      { _id: "a", _creationTime: 1, name: "Alice", age: 30 },
      { _id: "b", _creationTime: 2, name: "Bob", age: 25 },
    ];
    const ir = await inferTableSchema(tbl, fromArray(docs));
    expect(ir.sampled).toBe(2);
    expect(ir.truncated).toBe(false);
    expect(ir.columns.map((c) => c.name)).toEqual([
      "_creationTime",
      "_id",
      "age",
      "name",
    ]);
    expect(ir.columns.every((c) => !c.nullable)).toBe(true);
  });

  it("marks fields absent in some docs as nullable", async () => {
    const docs = [
      { _id: "a", name: "Alice", age: 30 },
      { _id: "b", name: "Bob" }, // age missing
    ];
    const ir = await inferTableSchema(tbl, fromArray(docs));
    const age = ir.columns.find((c) => c.name === "age");
    expect(age?.nullable).toBe(true);
    expect(age?.type).toEqual(t.number);
  });

  it("treats explicit null as nullable", async () => {
    const docs = [
      { _id: "a", snapshot: null },
      { _id: "b", snapshot: { headline: "x" } },
    ];
    const ir = await inferTableSchema(tbl, fromArray(docs));
    const snap = ir.columns.find((c) => c.name === "snapshot");
    expect(snap?.nullable).toBe(true);
    expect(snap?.type.kind).toBe("union");
    if (snap?.type.kind !== "union") return;
    const kinds = snap.type.members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["null", "object"]);
  });

  it("respects sampleSize and reports truncated", async () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({ _id: String(i) }));
    const ir = await inferTableSchema(tbl, fromArray(docs), { sampleSize: 10 });
    expect(ir.sampled).toBe(10);
    expect(ir.truncated).toBe(true);
  });

  it("folds array element types across rows", async () => {
    const docs = [
      { _id: "a", tags: ["x", "y"] },
      { _id: "b", tags: ["z", 42] },
    ];
    const ir = await inferTableSchema(tbl, fromArray(docs));
    const tags = ir.columns.find((c) => c.name === "tags");
    expect(tags?.type).toEqual({
      kind: "array",
      element: { kind: "union", members: [t.string, t.number] },
    });
  });
});
