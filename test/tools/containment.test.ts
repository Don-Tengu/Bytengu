import assert from "node:assert/strict";
import { createServer, type Server, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runLLMTool, runTool, type ToolSession } from "../../src/tools/index.ts";
import { errorOf, ok, provideFs, tempWorkspace } from "./harness.ts";

const PARENT = "/bin/ps -ww -o command= -p $PPID";

const quote = (path: string): string => JSON.stringify(path);

const listen = () =>
  new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

test("read-only keeps reads and refuses bash, edit, and write_file", async () => {
  const cwd = tempWorkspace();
  const session: ToolSession = { reads: new Set() };
  writeFileSync(join(cwd, "notes.txt"), "alpha-token\n");
  writeFileSync(join(cwd, "marker.txt"), "before\n");
  try {
    const read = await ok({ name: "read_file", arguments: { path: "notes.txt" } }, cwd, session, "read-only");
    assert.match(read.output, /alpha-token/);

    const found = await ok(
      { name: "grep", arguments: { pattern: "alpha-token", path: "notes.txt" } },
      cwd,
      undefined,
      "read-only",
    );
    assert.match(found.output, /alpha-token/);

    const listed = await ok({ name: "glob", arguments: { pattern: "*.txt" } }, cwd, undefined, "read-only");
    assert.match(listed.output, /notes\.txt/);
    assert.match(listed.output, /marker\.txt/);

    const bash = await provideFs(
      runLLMTool(
        "bash",
        JSON.stringify({ command: "echo hi > marker.txt" }),
        cwd,
        5_000,
        undefined,
        "read-only",
      ),
    );
    assert.equal(bash.ok, false);
    if (!bash.ok) assert.match(bash.error, /profile read-only does not allow bash/);
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "before\n");

    const edited = await provideFs(
      runLLMTool(
        "edit",
        JSON.stringify({ path: "notes.txt", old_string: "alpha-token", new_string: "changed" }),
        cwd,
        5_000,
        session,
        "read-only",
      ),
    );
    assert.equal(edited.ok, false);
    if (!edited.ok) assert.match(edited.error, /profile read-only does not allow edit/);
    assert.match(readFileSync(join(cwd, "notes.txt"), "utf8"), /alpha-token/);

    const written = await provideFs(
      runLLMTool(
        "write_file",
        JSON.stringify({ path: "fresh.txt", content: "nope\n" }),
        cwd,
        5_000,
        undefined,
        "read-only",
      ),
    );
    assert.equal(written.ok, false);
    if (!written.ok) assert.match(written.error, /profile read-only does not allow write_file/);
    assert.equal(existsSync(join(cwd, "fresh.txt")), false);

    const direct = await errorOf(
      { name: "bash", arguments: { command: "echo hi > marker.txt" } },
      cwd,
      undefined,
      "read-only",
    );
    assert.match(direct, /profile read-only does not allow bash/);
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "before\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workspace-write sandboxes bash and keeps file tools in the workspace", async () => {
  const cwd = tempWorkspace();
  const outside = realpathSync(tempWorkspace());
  mkdirSync(join(outside, ".bytengu"));
  const outsideFile = join(outside, "nope.txt");
  const dotFile = join(outside, ".bytengu", "probe");
  const { server, port } = await listen();
  let accepted = false;
  server.on("connection", (socket) => {
    accepted = true;
    socket.end();
  });
  try {
    const inside = await ok(
      { name: "bash", arguments: { command: "echo hi > contained.txt" } },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.equal(inside.ok, true);
    assert.equal(readFileSync(join(cwd, "contained.txt"), "utf8"), "hi\n");

    const wrote = await ok(
      { name: "write_file", arguments: { path: "from-write.txt", content: "kept\n" } },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.match(wrote.output, /wrote from-write\.txt/);
    const escaped = await errorOf(
      { name: "write_file", arguments: { path: outsideFile, content: "no\n" } },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.match(escaped, /escapes workspace/);
    assert.equal(existsSync(outsideFile), false);

    const denied = await ok(
      { name: "bash", arguments: { command: `echo hi > ${quote(outsideFile)}` } },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.equal(denied.ok, true);
    assert.match(denied.output, /not permitted/);
    assert.equal(existsSync(outsideFile), false);

    const deniedDot = await ok(
      { name: "bash", arguments: { command: `echo hi > ${quote(dotFile)}` } },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.equal(deniedDot.ok, true);
    assert.match(deniedDot.output, /not permitted/);
    assert.equal(existsSync(dotFile), false);

    const tree = await ok({ name: "bash", arguments: { command: PARENT } }, cwd, undefined, "workspace-write");
    assert.match(tree.output, /sandbox-exec/);

    const tcp = await ok(
      {
        name: "bash",
        arguments: {
          command: `node -e 'const net=require("net"); const s=net.connect({host:"127.0.0.1", port:${port}, family:4}); s.on("connect",()=>{console.log("connected"); process.exit(0)}); s.on("error",(e)=>{console.log(e.code||e.message); process.exit(2)})'`,
        },
      },
      cwd,
      undefined,
      "workspace-write",
    );
    assert.equal(tcp.ok, true);
    assert.match(tcp.output, /EPERM|Operation not permitted/);
    assert.doesNotMatch(tcp.output, /connected/);
    assert.equal(accepted, false);
  } finally {
    await closeServer(server);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the default profile is workspace-write", async () => {
  const cwd = tempWorkspace();
  try {
    const tree = await provideFs(runTool({ name: "bash", arguments: { command: PARENT } }, cwd));
    assert.equal(tree.ok, true);
    assert.match(tree.output, /sandbox-exec/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("full runs unsandboxed bash and can write outside the workspace", async () => {
  const cwd = tempWorkspace();
  const outside = realpathSync(tempWorkspace());
  const outsideFile = join(outside, "created.txt");
  try {
    const wrote = await ok(
      { name: "bash", arguments: { command: `echo hi > ${quote(outsideFile)}` } },
      cwd,
      undefined,
      "full",
    );
    assert.equal(wrote.ok, true);
    assert.match(wrote.output, /^exit 0/);
    assert.equal(readFileSync(outsideFile, "utf8"), "hi\n");

    const tree = await ok({ name: "bash", arguments: { command: PARENT } }, cwd, undefined, "full");
    assert.equal(tree.ok, true);
    assert.doesNotMatch(tree.output, /sandbox-exec/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
