# Bytengu

Bytengu is a local coding agent. One process, one tool loop, written with Effect. It borrows behavior from OpenCode (exact edit, paged read, device-code login) and does not copy OpenCode's server, AI SDK, plugin host, or database.

Until a TUI exists, every chat request uses xAI and the model `grok-4.7`. Do not add a provider picker, a model flag, or a thinking-level setting. The place those will plug in is `src/provider/registry.ts`.

## Commands

Run from this directory. Bun is the only runtime. Do not add npm scripts that call `tsx` or `node`.

- `bun run login` — Grok device-code login. Writes `~/.bytengu/auth.json` mode `0600`.
- `bun run chat --cwd <dir> "prompt"` — one shot. Optional `--test "<cmd>"` runs that command in `<dir>` before and after the model. Optional `--out <file>`.
- `bun test` — unit tests under `test/`. They must not call xAI.
- `bun run typecheck`

`fixtures/workspace-hard` is a broken exercise for the agent. Do not fix those files unless the task is to run the agent against them. `bun test` does not scan `fixtures/`.

## Layout

```
src/chat.ts            model loop
src/login.ts           device-code login
src/proxy.ts           HTTPS_PROXY for Bun fetch
src/auth/store.ts      ~/.bytengu/auth.json
src/provider/          xAI today; add the next provider beside it
src/tools/             one file per tool, public entry is index.ts
test/chat/             loop helpers; sessions land here later
test/proxy/
test/tools/            one file per tool, shared setup in harness.ts
test/provider/         one file per provider
```

Imports use the `.ts` suffix. `verbatimModuleSyntax` is on.

## Loop

`src/chat.ts` is a `for` loop, at most 30 steps. Each step posts `messages` to `${baseUrl}/chat/completions`, appends the provider's original assistant object, and if there are tool calls, runs them in order. A step with no tool calls stops the loop.

Keep unknown assistant fields. The decoder may drop them; the next request must still send the object the provider returned.

Tool calls in one assistant message run sequentially. Do not use unbounded `Effect.all` for them. An edit and the bash that tests it must not overlap.

`streak` counts identical `name + arguments`. The third repeat is not executed. The count survives later steps of the same process and dies when the process exits.

`ToolSession.reads` is the set of relative paths successfully read as UTF-8 files in this process. `edit` refuses a path that is not in the set when a session is passed. Directory listings are not recorded.

## Tools

`{ ok: true, output }` means the tool ran. That includes bash timeouts and non-zero exits. `ToolFailure` / `{ ok: false, error }` means bad arguments, a path outside the workspace, or an I/O error. The model must see the difference.

Paths stay inside the workspace after `realpath`. A symlink that leaves the workspace is a failure. `/tmp` on macOS is `/private/tmp`; every tool in one call uses the same real root.

`read_file` returns at most 200 lines from `offset` (1-based), prefixed `N| `. The prefix is not file text. The implementation reads the whole file, then slices.

`edit` replaces an exact `old_string`. Empty `old_string`, identical strings, a missing match, and multiple matches without `replace_all` fail and leave the file unchanged. It does not create files and it does not fuzzy-match whitespace. `write_file` creates files and parent directories.

`grep` and `glob` prefer `rg`. Tests set `BYTENGU_NO_RG=1` to force the walk. Do not shell out to `find` or `grep` from the model prompt as the search path.

## Auth

Bearer resolution, in order: oauth record in the auth file, then a stored api record, then `XAI_API_KEY`. A saved oauth login wins over `XAI_API_KEY`. Refresh when the stored expiry or the JWT `exp` is inside two minutes. One refresh at a time. Never print access or refresh tokens.

`.env` values `BASE_URL`, `API_KEY`, and `MODEL` are not read by the chat loop.

The device-code client id is the public Grok CLI client. `referrer` is `bytengu`. Do not copy OpenCode's user-agent or `referrer=opencode`.

## Effect

Stay on Effect 3 (`Effect<A, E, R>`). New code may return `Effect`. Do not add `Layer`, `Context.Service`, or a tool registry service. A plain object and a `switch` are the extension points.

## Do not build yet

Interactive multi-turn sessions, `--resume`, permission prompts, streaming, compaction, the Responses API, Anthropic's message format, and a TUI. When a provider is added, give it a `baseUrl`, a default model, and a `bearer()` next to xAI. A different wire protocol gets its own `complete()` behind that provider. It does not fork `src/chat.ts`.
