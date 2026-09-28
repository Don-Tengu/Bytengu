# Instruction sample

A small project for the system-message walk. It does not call xAI.

From the Bytengu repo root:

```bash
bun fixtures/instructions/show.ts
```

That prepares `fixtures/instructions/.demo` with its own `.git` file, prints the system message for three directories, and checks the secrets below.

| Directory | Included | Left out |
|---|---|---|
| `.demo/pkg` | package label `tangerine`, then repository label `lighthouse` | `PARENT-CLAUDE`, `CHILD-CLAUDE`, `ABOVE-GIT` |
| `.demo/claude-only` | claude label `cobalt`, then `lighthouse` | `PARENT-CLAUDE` |
| `.demo` | `lighthouse` | `PARENT-CLAUDE` |

`.demo` is gitignored. The walk stops at its `.git` file, so Bytengu's own `AGENTS.md` is not included.

A live turn uses a login and one model request:

```bash
bun run chat --cwd fixtures/instructions/.demo/pkg --profile read-only "What are the package label and the repository label?"
```

Run `show.ts` once before that command so `.demo` exists.
