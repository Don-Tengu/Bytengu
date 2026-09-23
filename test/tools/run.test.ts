import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodeToolCall, emptyStreak, llmTools, runLLMToolsInOrder, type ToolSession } from "../../src/tools/index.ts";
import { provideFs, tempWorkspace } from "./harness.ts";

test("tool calls in one message run in order, and the third identical call does not run", async () => {
  const cwd = tempWorkspace();
  try {
    const log = join(cwd, "order.txt");
    const session: ToolSession = { reads: new Set() };
    const ordered = await provideFs(
      runLLMToolsInOrder(
        [
          { id: "1", name: "bash", arguments: JSON.stringify({ command: `echo a >> '${log}' && sleep 0.3` }) },
          { id: "2", name: "bash", arguments: JSON.stringify({ command: `echo b >> '${log}'` }) },
        ],
        cwd,
        session,
        emptyStreak(),
        5_000,
      ),
    );
    assert.equal(ordered.stopped, false);
    assert.equal(readFileSync(log, "utf8"), "a\nb\n");

    const repeatLog = join(cwd, "repeat.txt");
    const command = JSON.stringify({ command: `echo x >> '${repeatLog}'` });
    const repeated = await provideFs(
      runLLMToolsInOrder(
        [
          { id: "1", name: "bash", arguments: command },
          { id: "2", name: "bash", arguments: command },
          { id: "3", name: "bash", arguments: command },
          { id: "4", name: "bash", arguments: command },
        ],
        cwd,
        session,
        emptyStreak(),
        5_000,
      ),
    );
    assert.equal(repeated.stopped, true);
    assert.equal(readFileSync(repeatLog, "utf8"), "x\nx\n");
    assert.match(repeated.results[2]?.result.ok === false ? repeated.results[2].result.error : "", /repeated 3 times/);
    assert.match(repeated.results[3]?.result.ok === false ? repeated.results[3].result.error : "", /not executed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("tool schemas advertise edit and keep read_file's extra fields optional", async () => {
  const edit = llmTools.find((item) => item.function.name === "edit");
  assert.ok(edit);
  const parameters = edit.function.parameters as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(parameters.required?.slice().sort(), ["new_string", "old_string", "path"]);
  assert.ok(parameters.properties?.replace_all);

  const decoded = await provideFs(decodeToolCall({ name: "read_file", arguments: { path: "notes.txt" } }));
  assert.equal(decoded.name, "read_file");
});
