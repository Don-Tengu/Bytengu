import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { systemMessage } from "../../src/chat.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, ".demo");

rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
cpSync(join(here, "project"), demo, { recursive: true });
writeFileSync(join(demo, ".git"), "gitdir: fixture\n");

const message = (dir: string) =>
  Effect.runPromise(systemMessage(dir).pipe(Effect.provide(NodeFileSystem.layer)));

const pkg = await message(join(demo, "pkg"));
const claudeOnly = await message(join(demo, "claude-only"));
const root = await message(demo);

const checks: Array<[string, boolean]> = [
  ["pkg includes the package label before the repository label", pkg.indexOf("tangerine") < pkg.indexOf("lighthouse")],
  ["pkg includes the package label line", pkg.includes("Package label: tangerine")],
  ["pkg includes the repository label line", pkg.includes("Repository label: lighthouse")],
  ["pkg omits PARENT-CLAUDE", !pkg.includes("PARENT-CLAUDE")],
  ["pkg omits CHILD-CLAUDE", !pkg.includes("CHILD-CLAUDE")],
  ["pkg omits ABOVE-GIT", !pkg.includes("ABOVE-GIT")],
  ["pkg keeps the tool list", pkg.includes("Tools: read_file, edit, write_file, grep, glob, and bash.")],
  ["claude-only includes cobalt", claudeOnly.includes("cobalt")],
  ["claude-only still includes the parent AGENTS.md", claudeOnly.includes("lighthouse")],
  ["claude-only omits PARENT-CLAUDE", !claudeOnly.includes("PARENT-CLAUDE")],
  ["root includes lighthouse", root.includes("lighthouse")],
  ["root omits PARENT-CLAUDE", !root.includes("PARENT-CLAUDE")],
  ["root omits Bytengu's own AGENTS.md", !root.includes("device-code login")],
];

console.log(`Prepared ${demo}`);
console.log("\n===== pkg =====\n");
console.log(pkg);
console.log("\n===== claude-only =====\n");
console.log(claudeOnly);
console.log("\n===== project root =====\n");
console.log(root);
console.log("\n===== checks =====");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "pass" : "fail"}  ${label}`);
  if (!ok) failed += 1;
}
if (failed > 0) process.exit(1);
