# Bytengu

Bytengu is a local coding agent. One process, one tool loop. Runtime code is Effect. It borrows behavior from OpenCode (exact edit, paged read, device-code login) and does not copy OpenCode's server, AI SDK, plugin host, or database.

Until a TUI exists, every chat request uses xAI and the model `grok-4.7`. Do not add a provider picker, a model flag, or a thinking-level setting. The place those will plug in is `src/provider/registry.ts`.

## Effect

This is the project rule. Write runtime code as `Effect`, including login, auth files, token refresh, HTTP, and tools. Compose with `Effect.gen`. Failures are `Data.TaggedError` (or `PlatformError` from `FileSystem`). Delays are `Effect.sleep`. File IO goes through `FileSystem.FileSystem`.

Do not write a finished `async` function and wrap it in `Effect.tryPromise` at the chat loop. The function itself is the Effect. Tests run it with `Effect.runPromise` and `Effect.provide(NodeFileSystem.layer)`.

Stay on Effect 3 (`Effect<A, E, R>`). Do not add `Layer` or `Context.Service`. The chat loop stays a plain `Effect.gen`. A provider is a plain object whose operations return `Effect`. A tool dispatch is a `switch`.

## Dispatch

Do not ask the user to open `/agents`. A one-line question stays in this session. A change, a test run, or a review of this repo launches the `bytengu` workflow. Pass `task` as what they asked, and `kind`:

- `implement` — explore, then implement, then test, then review. This is the default.
- `explore` — find the files only.
- `test` — tests only.
- `review` — read the diff only.

The user can also run `/bytengu`.

## Commands

Run from this directory. Bun is the only runtime. Do not add npm scripts that call `tsx` or `node`.

- `bun run login` — Grok device-code login. Writes `~/.bytengu/auth.json` mode `0600`.
- `bun run chat --cwd <dir> "prompt"` — one shot. Optional `--out <file>`. Optional `--profile read-only|workspace-write|full`. Optional `--format human|json`. Optional `--mode plan`. Optional `--continue`. The default profile is `workspace-write`. The default format is `human`: stdout is the final assistant text, and progress stays on stderr. Omitting `--mode` keeps that editing run: `edit`, `write_file`, and `bash` still run. Omitting `--continue` starts a new conversation.
- `bun test` — unit tests under `test/`. They must not call xAI.
- `bun run typecheck`

`fixtures/workspace-hard` is a broken exercise for the agent. Do not fix those files unless the task is to run the agent against them. `bun test` does not scan `fixtures/`. `bun fixtures/instructions/show.ts` prints the system message for `fixtures/instructions` without calling xAI.

## Layout

```
src/chat.ts            model loop
src/headless.ts        exit codes, JSON events, audit lines
src/instructions.ts    AGENTS.md / CLAUDE.md for the system message
src/login.ts           device-code login
src/proxy.ts           HTTPS_PROXY for Bun fetch
src/auth/store.ts      ~/.bytengu/auth.json
src/session.ts         latest workspace session in ~/.bytengu/bytengu.db
src/provider/          xAI today; add the next provider beside it
src/tools/             one file per tool, public entry is index.ts
test/chat/             loop helpers
test/proxy/
test/tools/            one file per tool, shared setup in harness.ts
test/provider/         one file per provider
.grok/agents/          bytengu-explore, implement, test, review
```

Imports use the `.ts` suffix. `verbatimModuleSyntax` is on.

## Loop

`src/chat.ts` is a `for` loop, at most 30 steps. Each step posts `messages` to `${baseUrl}/chat/completions`, appends the provider's original assistant object, and if there are tool calls, runs them in order. A step with no tool calls stops the loop.

Keep unknown assistant fields. The decoder may drop them; the next request must still send the object the provider returned.

Tool calls in one assistant message run sequentially. Do not use unbounded `Effect.all` for them. An edit and the bash that tests it must not overlap.

`streak` counts identical `name + arguments`. The third repeat is not executed. The count survives later steps of the same process and dies when the process exits.

`ToolSession.reads` is the set of relative paths successfully read as UTF-8 files in this process. `edit` refuses a path that is not in the set when a session is passed. Directory listings are not recorded.

The system message starts with the fixed tool instructions. It then appends `AGENTS.md` from the workspace directory upward, nearest first, through the directory that contains `.git` (a file or a directory). That block is labeled as project files to follow. A directory on that walk with no regular `AGENTS.md` file contributes `CLAUDE.md` instead. Files above the git root are not read. With no `.git` at or above the workspace, ancestors of the workspace are not read. A path with either name that is not a regular file is ignored. The appended text is truncated to 32000 characters from the start. Those files are read as text and are not executed.

## Headless contract

The one-shot process uses one exit table. The same case returns the same code on every launch.

- `0` — clean stop. The assistant message has no tool calls. A tool result `{ ok: false }` does not change this: if the assistant then stops with no tool calls, the process still exits `0`.
- `1` — startup or model error. An unknown profile, an unknown mode, an unknown format, an empty prompt, missing auth, a missing workspace, a workspace that is not a directory, or a failed model request.
- `2` — the loop reached the 30-step cap.
- `3` — the same tool name and arguments was repeated 3 times. That call is not executed.

`--format human` is the default. Stdout is the final assistant text only. `--format json` writes only JSON objects, one per line, in order: a `step` event for every model step that started (`{"type":"step","step":1}`), a `tool` event for each recorded tool call (`{"type":"tool","name":"read_file","ok":true}`), an `assistant` event with the final assistant text when there is any, and a closing `done` event (`{"type":"done","reason":"clean"}`). `done.reason` is `clean`, `error`, `step-cap`, or `repeated-tool`, the same reason that selected the exit code, including when the exit is `1` and no step started. JSON events omit tool arguments, tool output, file bodies, access tokens, refresh tokens, and API keys.

`--out` is written for a clean stop, the 30-step cap, the repeated-tool stop, and a model-request failure after a completed assistant turn. It is not written for a pre-loop failure (unknown profile, unknown mode, unknown format, empty prompt, missing auth, missing workspace, or a workspace that is not a directory).

Each recorded tool call appends one line to `~/.bytengu/audit.log`. The file mode is `0600`. A later run appends and does not rewrite earlier lines. A run with no tool calls appends no line. The refused third repeat is a failure line. Each line has a timestamp, the approval profile, the workspace directory, the tool name, whether the result was ok or a failure (`ok`), and the process stop reason (`reason`). Lines omit tool arguments, tool output, file bodies, and tokens. Human stdout and JSON stdout use the same audit file.

## Tools

`{ ok: true, output }` means the tool ran. That includes bash timeouts and non-zero exits. `ToolFailure` / `{ ok: false, error }` means bad arguments, a path outside the workspace, or an I/O error. The model must see the difference.

Paths stay inside the workspace after `realpath`. A symlink that leaves the workspace is a failure. `/tmp` on macOS is `/private/tmp`; every tool in one call uses the same real root.

`read_file` returns at most 200 lines from `offset` (1-based), prefixed `N| `. The prefix is not file text. The implementation reads the whole file, then slices.

`edit` replaces an exact `old_string`. Empty `old_string`, identical strings, a missing match, and multiple matches without `replace_all` fail and leave the file unchanged. It does not create files and it does not fuzzy-match whitespace. `write_file` creates files and parent directories.

`grep` and `glob` prefer `rg`. Tests set `BYTENGU_NO_RG=1` to force the walk. Do not shell out to `find` or `grep` from the model prompt as the search path.

`--profile` selects an approval profile: `read-only`, `workspace-write`, or `full`. The default profile is `workspace-write`. `full` applies only when that name is passed. `read-only` still runs `read_file`, `grep`, and `glob`. `bash`, `edit`, and `write_file` return a tool failure and leave the workspace unchanged. `workspace-write` keeps `edit` and `write_file` inside the realpath jail and runs `bash` through `sandbox-exec`. `full` runs `bash` as unsandboxed `/bin/bash -lc`.

`--mode plan` is the one-shot plan mode. That run reads the project and the system text tells the model to name which files to change and how to check, and not to modify files. `read_file`, `grep`, and `glob` still run. `edit`, `write_file`, and `bash` return a tool failure before any write or child process, including when `--profile` is `workspace-write`, `full`, or `read-only`. The plan is the assistant text on stdout. Omitting `--mode` keeps today's editing run.

`--continue` continues the latest session for that workspace. The session stores the user prompt, the provider's assistant messages (including tool-call fields), and tool results in `~/.bytengu/bytengu.db`. That file is outside the workspace, so a later process still loads the conversation when `--out` is a different path. The new prompt is posted after the stored messages. When that workspace has no stored session, `--continue` starts a new conversation and a clean stop still exits `0`. Omitting `--continue` starts a new conversation, and that conversation becomes the latest session for the workspace. `--continue` on another workspace does not load this one. The in-process read-before-edit set is not restored.

## Auth

Bearer resolution, in order: oauth record in the auth file, then a stored api record, then `XAI_API_KEY`. A saved oauth login wins over `XAI_API_KEY`. Refresh when the stored expiry or the JWT `exp` is inside two minutes. One refresh at a time. Never print access or refresh tokens.

`.env` values `BASE_URL`, `API_KEY`, and `MODEL` are not read by the chat loop.

The device-code client id is the public Grok CLI client. `referrer` is `bytengu`. Do not copy OpenCode's user-agent or `referrer=opencode`.

## Do not build yet

A process that stays open for another typed line, `--resume`, interactive yes/no permission prompts, streaming, compaction, the Responses API, Anthropic's message format, and a TUI. One-shot `--continue` is the session above. Approval profiles on the one-shot command are the `--profile` flag above. When a provider is added, give it a `baseUrl`, a default model, and a `bearer()` next to xAI. A different wire protocol gets its own `complete()` behind that provider. It does not fork `src/chat.ts`.
