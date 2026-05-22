import { describe, expect, it } from "vitest";
import { ScriptedPrompter } from "../src/lib/prompter.js";

describe("ScriptedPrompter", () => {
  it("returns answers in order across prompt types", async () => {
    const p = new ScriptedPrompter([
      "https://example.convex.cloud",
      true,
      "key-pair" as const,
      "secret-value",
    ]);

    expect(await p.text({ message: "URL" })).toBe(
      "https://example.convex.cloud",
    );
    expect(await p.confirm({ message: "Proceed?" })).toBe(true);
    expect(
      await p.select({
        message: "Auth",
        options: [
          { value: "password" as const, label: "Password" },
          { value: "key-pair" as const, label: "Key pair" },
        ],
      }),
    ).toBe("key-pair");
    expect(await p.secret({ message: "Token" })).toBe("secret-value");
    expect(p.drained()).toBe(true);
  });

  it("captures notes without consuming answers", async () => {
    const p = new ScriptedPrompter(["only-answer"]);
    p.note("Looking for Convex...");
    p.note("Found it");
    expect(p.notes).toEqual(["Looking for Convex...", "Found it"]);
    expect(await p.text({ message: "x" })).toBe("only-answer");
  });

  it("throws when answers run out", async () => {
    const p = new ScriptedPrompter([]);
    await expect(p.text({ message: "x" })).rejects.toThrow(/ran out/);
  });
});
