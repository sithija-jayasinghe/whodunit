import { resolve } from "node:path";

import { checkPreconditions } from "../commands/doctor.js";
import { listHunks } from "../commands/hunks.js";
import { search } from "../commands/search.js";
import { repoRoot } from "../git/repo.js";
import { hunksToJson, preconditionsToJson, searchToJson } from "../report/json.js";
import { SKIP_EXIT_CODE } from "../runner/test.js";

/** What a running tool can do besides return its result. */
export interface ToolContext {
  /** Report a step of a long run. Dropped if the client did not ask. */
  progress(message: string): void;
  /** Aborts when the client cancels the request. */
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  run(args: Record<string, unknown>, context: ToolContext): Promise<object>;
}

/**
 * A problem with the arguments. Reported to the model as a tool error rather
 * than a protocol error, so it can read the message and retry.
 */
export class ToolInputError extends Error {}

// Shared pieces of the input schemas. The schemas are what the model reads, so
// the descriptions say how to use each field, not just what type it is.
const cwd = {
  type: "string",
  description: "Absolute path to the Git repository (or any directory inside it).",
};
const command = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  description:
    'The test command as an argument list, e.g. ["npm", "test", "auth.test.ts"]. ' +
    'Not run through a shell; use ["sh", "-c", "..."] for pipes or &&. ' +
    "Point it at the single failing test: the search runs it many times.",
};
const since = {
  type: "string",
  description: "Baseline commit or ref to compare against. Default: HEAD, which searches uncommitted changes.",
};
const timeoutMs = {
  type: "integer",
  minimum: 1,
  description: "Kill a single test run after this many milliseconds. Default: 600000.",
};
const skipExitCodes = {
  type: "array",
  items: { type: "integer", minimum: 1, maximum: 255 },
  description:
    'Extra exit codes meaning "cannot test this state", e.g. a build failure. 125 always counts.',
};
const context = {
  type: "integer",
  minimum: 0,
  description: "Diff context lines. Default: 1. Higher values merge nearby changes into one hunk.",
};
const verbose = {
  type: "boolean",
  description: "Include the stdout and stderr of the baseline and current runs.",
};

type Arguments = Record<string, unknown>;

function checkKnown(args: Arguments, schema: { properties: object }): void {
  const known = Object.keys(schema.properties);
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      throw new ToolInputError(`Unknown argument "${key}". Expected: ${known.join(", ")}.`);
    }
  }
}

function optionalString(args: Arguments, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new ToolInputError(`"${key}" must be a non-empty string.`);
  }
  return value;
}

function requiredString(args: Arguments, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new ToolInputError(`"${key}" is required.`);
  return value;
}

function optionalInteger(args: Arguments, key: string, min: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ToolInputError(`"${key}" must be a whole number of at least ${min}.`);
  }
  return value;
}

function optionalBoolean(args: Arguments, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`"${key}" must be true or false.`);
  return value;
}

function commandArgument(args: Arguments): string[] {
  const value = args.command;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((part): part is string => typeof part === "string")
  ) {
    throw new ToolInputError(
      '"command" is required: a non-empty array of strings, e.g. ["npm", "test"].',
    );
  }
  return value;
}

function skipCodesArgument(args: Arguments): number[] {
  const value = args.skipExitCodes ?? [];
  if (
    !Array.isArray(value) ||
    !value.every((code) => typeof code === "number" && Number.isInteger(code) && code >= 1 && code <= 255)
  ) {
    throw new ToolInputError('"skipExitCodes" must be an array of whole numbers from 1 to 255.');
  }
  return [SKIP_EXIT_CODE, ...(value as number[])];
}

/** The repository root for `cwd`. Relative paths resolve against the server's cwd. */
async function repoArgument(args: Arguments): Promise<string> {
  return repoRoot(resolve(requiredString(args, "cwd")));
}

const repeat = {
  type: "integer",
  minimum: 1,
  description:
    "Run the baseline, the current tree and the answer this many times each, to catch a " +
    "flaky test. A non-null flaky field in the result means the test is not deterministic " +
    "and the answer must not be trusted. Default: 1. Use 2 or 3 if the test might be flaky.",
};

const match = {
  type: "string",
  description:
    "Text the test's output must contain for a failure to count, such as the assertion " +
    "message of the failure being hunted. A run that fails some other way (a different " +
    "test, an import error) is skipped instead of being taken for the culprit.",
};

const maxProbes = {
  type: "integer",
  minimum: 1,
  description: "Give up after this many search runs and return the best set found. Default: 60.",
};

const searchSchema = {
  type: "object",
  properties: { cwd, command, since, timeoutMs, maxProbes, repeat, match, skipExitCodes, context, verbose },
  required: ["cwd", "command"],
  additionalProperties: false,
};

const doctorSchema = {
  type: "object",
  properties: { cwd, command, since, timeoutMs, repeat, match, skipExitCodes, verbose },
  required: ["cwd", "command"],
  additionalProperties: false,
};

const hunksSchema = {
  type: "object",
  properties: { cwd, since, context },
  required: ["cwd"],
  additionalProperties: false,
};

export const TOOLS: readonly Tool[] = [
  {
    name: "whodunit_search",
    title: "Find the change that broke a test",
    description:
      "Splits the working tree's changes into hunks and runs the failing test against " +
      "subsets of them until it proves the smallest set that still makes the test fail. " +
      "Use it when a test went red after a set of edits and the cause is not obvious. " +
      "Runs in a throwaway git worktree; the real working tree is never modified. " +
      "The result's culprits are the proven cause; minimal=false means the probe budget " +
      "ran out first, and a non-null flaky means the test is not deterministic, so the " +
      "answer is not trustworthy. If searchable is false, reason says why (for example the test " +
      "already failed at the baseline).",
    inputSchema: searchSchema,
    async run(args, context) {
      checkKnown(args, searchSchema);
      const options = {
        repo: await repoArgument(args),
        baselineRef: optionalString(args, "since") ?? "HEAD",
        testCommand: commandArgument(args),
        timeoutMs: optionalInteger(args, "timeoutMs", 1),
        maxProbes: optionalInteger(args, "maxProbes", 1),
        repeat: optionalInteger(args, "repeat", 1),
        match: optionalString(args, "match"),
        skipExitCodes: skipCodesArgument(args),
        contextLines: optionalInteger(args, "context", 0),
      };
      const report = await search({
        ...options,
        signal: context.signal,
        onStep: (message) => context.progress(message),
        onProbe: (event) => {
          if (event.cached) return;
          context.progress(
            `Run ${event.probe}: ${event.subset.length} of ${event.of} changes, ${event.outcome}`,
          );
        },
      });
      return searchToJson(report, { verbose: optionalBoolean(args, "verbose") });
    },
  },
  {
    name: "whodunit_doctor",
    title: "Check whether there is a regression to search",
    description:
      "Runs the test once at the baseline and once on the current working tree, without " +
      "searching. searchable=true means the baseline passes and the current tree fails, " +
      "so whodunit_search can find the cause. Cheaper than a search: use it first when " +
      "unsure whether the edits broke the test.",
    inputSchema: doctorSchema,
    async run(args, context) {
      checkKnown(args, doctorSchema);
      const report = await checkPreconditions({
        repo: await repoArgument(args),
        baselineRef: optionalString(args, "since") ?? "HEAD",
        testCommand: commandArgument(args),
        timeoutMs: optionalInteger(args, "timeoutMs", 1),
        repeat: optionalInteger(args, "repeat", 1),
        match: optionalString(args, "match"),
        skipExitCodes: skipCodesArgument(args),
        signal: context.signal,
        onStep: (message) => context.progress(message),
      });
      return preconditionsToJson(report, { verbose: optionalBoolean(args, "verbose") });
    },
  },
  {
    name: "whodunit_hunks",
    title: "List the changes a search would split",
    description:
      "Lists every hunk of the working tree's changes against the baseline, each with its " +
      "file, line and patch. Runs no tests.",
    inputSchema: hunksSchema,
    async run(args) {
      checkKnown(args, hunksSchema);
      const listing = await listHunks({
        repo: await repoArgument(args),
        baselineRef: optionalString(args, "since") ?? "HEAD",
        contextLines: optionalInteger(args, "context", 0),
      });
      return hunksToJson(listing);
    },
  },
];
