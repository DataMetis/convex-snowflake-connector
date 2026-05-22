#!/usr/bin/env node
// Quality gates orchestrator — runs sequentially, fails fast.
// Mirrors the pattern from sibling starter kits.

import { spawnSync } from "node:child_process";

const gates = [
  {
    name: "TypeScript Type Checking",
    icon: "📘",
    cmd: "bun",
    args: ["run", "typecheck"],
  },
  {
    name: "ESLint",
    icon: "🔍",
    cmd: "bun",
    args: ["run", "lint"],
  },
  {
    name: "Prettier Format Check",
    icon: "✨",
    cmd: "bun",
    args: ["run", "format:check"],
    autoFix: { cmd: "bun", args: ["run", "format"] },
  },
];

console.log("\n🚀 Running Quality Gates\n");
console.log("=".repeat(50));

let passed = 0;
for (const gate of gates) {
  console.log(`\n${gate.icon}  ${gate.name}...`);
  let result = spawnSync(gate.cmd, gate.args, { stdio: "pipe" });
  if (result.status !== 0 && gate.autoFix) {
    console.log("   ⚠️  Failed — attempting auto-fix...");
    spawnSync(gate.autoFix.cmd, gate.autoFix.args, { stdio: "inherit" });
    result = spawnSync(gate.cmd, gate.args, { stdio: "pipe" });
    if (result.status === 0) {
      console.log("   ✅ Fixed and passed");
      passed++;
      continue;
    }
  }
  if (result.status === 0) {
    console.log("   ✅ Passed");
    passed++;
  } else {
    process.stdout.write(result.stdout?.toString() ?? "");
    process.stderr.write(result.stderr?.toString() ?? "");
    console.log(`   ❌ Failed`);
    console.log("\n" + "=".repeat(50));
    console.log(`\n❌ Quality gate failed: ${gate.name}\n`);
    process.exit(1);
  }
}

console.log("\n" + "=".repeat(50));
console.log(`\n✅ All quality gates passed (${passed}/${gates.length})\n`);
