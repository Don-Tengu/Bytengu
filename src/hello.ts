import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Data, Effect, ParseResult, Schema } from "effect";

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

class LoadError extends Data.TaggedError("LoadError")<{
  readonly message: string;
}> {}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

const loadPerson = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path, "utf8");
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new LoadError({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    return yield* Schema.decodeUnknown(Person)(json).pipe(
      Effect.mapError(
        (error) =>
          new LoadError({
            message: `Invalid person file: ${path}\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
          }),
      ),
    );
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [person, notes] = yield* Effect.all(
    [
      loadPerson(join(fixturesDir, "person.json")),
      fs.readFileString(join(fixturesDir, "notes.txt"), "utf8"),
    ],
    { concurrency: 2 },
  );
  console.log(notes);
  console.log(`${person.name} is ${person.age}`);
});

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

if (isMainModule()) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
}
