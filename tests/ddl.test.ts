import { describe, expect, it } from "vitest";
import {
  generateAllDDL,
  generateTableDDL,
  qualifiedName,
  quoteIdent,
  snowflakeColumnType,
} from "../src/lib/ddl.js";
import type { ColumnSchema, TableSchema } from "../src/lib/ir.js";

const target = { database: "IHDB", schema: "PUBLIC" };

function col(
  name: string,
  type: ColumnSchema["type"],
  nullable = false,
): ColumnSchema {
  return { name, type, nullable };
}

describe("snowflakeColumnType", () => {
  it("maps scalars per spec §2", () => {
    expect(snowflakeColumnType({ kind: "string" })).toBe("VARCHAR");
    expect(snowflakeColumnType({ kind: "number" })).toBe("NUMBER");
    expect(snowflakeColumnType({ kind: "boolean" })).toBe("BOOLEAN");
    expect(snowflakeColumnType({ kind: "bytes" })).toBe("BINARY");
  });

  it("collapses composite + any + null to VARIANT", () => {
    expect(snowflakeColumnType({ kind: "any" })).toBe("VARIANT");
    expect(snowflakeColumnType({ kind: "null" })).toBe("VARIANT");
    expect(
      snowflakeColumnType({ kind: "array", element: { kind: "string" } }),
    ).toBe("VARIANT");
    expect(snowflakeColumnType({ kind: "object", fields: {} })).toBe("VARIANT");
    expect(
      snowflakeColumnType({
        kind: "union",
        members: [{ kind: "string" }, { kind: "number" }],
      }),
    ).toBe("VARIANT");
  });
});

describe("quoteIdent & qualifiedName", () => {
  it("preserves camelCase via double quotes", () => {
    expect(quoteIdent("rulerBattles")).toBe('"rulerBattles"');
  });

  it("escapes embedded quotes", () => {
    expect(quoteIdent('foo"bar')).toBe('"foo""bar"');
  });

  it("renders fully-qualified names", () => {
    expect(qualifiedName(target, "users")).toBe('"IHDB"."PUBLIC"."users"');
  });
});

describe("generateTableDDL", () => {
  it("orders _id first, _creationTime second, then alphabetical", () => {
    const schema: TableSchema = {
      path: "users",
      name: "users",
      system: false,
      sampled: 2,
      truncated: false,
      columns: [
        col("name", { kind: "string" }),
        col("_creationTime", { kind: "number" }),
        col("age", { kind: "number" }, true),
        col("_id", { kind: "string" }),
      ],
    };
    const sql = generateTableDDL(schema, target);
    const lines = sql.split("\n");
    expect(lines[0]).toBe('CREATE OR REPLACE TABLE "IHDB"."PUBLIC"."users" (');
    expect(lines[1]).toContain('"_id" VARCHAR NOT NULL PRIMARY KEY');
    expect(lines[2]).toContain('"_creationTime" TIMESTAMP_NTZ NOT NULL');
    expect(lines[3]).toContain('"age" NUMBER NULL');
    expect(lines[4]).toContain('"name" VARCHAR NOT NULL');
    expect(lines.at(-1)).toBe(");");
  });

  it("marks nullable columns NULL and non-nullable NOT NULL", () => {
    const schema: TableSchema = {
      path: "t",
      name: "t",
      system: false,
      sampled: 1,
      truncated: false,
      columns: [
        col("_id", { kind: "string" }),
        col("optional_field", { kind: "string" }, true),
        col("required_field", { kind: "string" }, false),
      ],
    };
    const sql = generateTableDDL(schema, target);
    expect(sql).toContain('"optional_field" VARCHAR NULL');
    expect(sql).toContain('"required_field" VARCHAR NOT NULL');
  });

  it("emits VARIANT for arrays/objects/unions", () => {
    const schema: TableSchema = {
      path: "t",
      name: "t",
      system: false,
      sampled: 1,
      truncated: false,
      columns: [
        col("_id", { kind: "string" }),
        col("tags", { kind: "array", element: { kind: "string" } }),
        col("meta", { kind: "object", fields: { x: { kind: "string" } } }),
        col("either", {
          kind: "union",
          members: [{ kind: "string" }, { kind: "number" }],
        }),
      ],
    };
    const sql = generateTableDDL(schema, target);
    expect(sql).toContain('"tags" VARIANT');
    expect(sql).toContain('"meta" VARIANT');
    expect(sql).toContain('"either" VARIANT');
  });

  it("returns empty string for tables with no columns", () => {
    const schema: TableSchema = {
      path: "empty",
      name: "empty",
      system: false,
      sampled: 0,
      truncated: false,
      columns: [],
    };
    expect(generateTableDDL(schema, target)).toBe("");
  });
});

describe("generateAllDDL", () => {
  it("joins statements with blank lines and reports empty tables", () => {
    const schemas: TableSchema[] = [
      {
        path: "a",
        name: "a",
        system: false,
        sampled: 1,
        truncated: false,
        columns: [col("_id", { kind: "string" })],
      },
      {
        path: "empty",
        name: "empty",
        system: false,
        sampled: 0,
        truncated: false,
        columns: [],
      },
      {
        path: "b",
        name: "b",
        system: false,
        sampled: 1,
        truncated: false,
        columns: [col("_id", { kind: "string" })],
      },
    ];
    const { ddl, skipped } = generateAllDDL(schemas, target);
    expect(skipped).toEqual(["empty"]);
    expect(ddl).toMatch(/CREATE OR REPLACE TABLE "IHDB"\."PUBLIC"\."a"/);
    expect(ddl).toMatch(/CREATE OR REPLACE TABLE "IHDB"\."PUBLIC"\."b"/);
    expect(ddl.match(/CREATE OR REPLACE TABLE/g)?.length).toBe(2);
  });
});
