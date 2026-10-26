import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { TOOLS, ToolInputError } from "./tools.js";

/**
 * Protocol versions whodunit speaks.
 *
 * MCP changed shape in 2026-07-28. Modern versions carry the version and the
 * client's capabilities in every request's `_meta` and have no handshake.
 * Legacy versions open with an `initialize` request instead. whodunit serves
 * both ("dual-era"), deciding per request, so it works with clients from
 * either side of that change.
 */
export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const INSTRUCTIONS =
  "whodunit finds which change in a working tree broke a test, by running the test " +
  "against subsets of the changes. Call whodunit_doctor first if unsure whether the " +
  "edits broke the test, then whodunit_search. Pass the single failing test as the " +
  "command, not the whole suite: the search runs it many times.";

// JSON-RPC error codes, plus the one MCP code we use.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Id = string | number;
type Params = Record<string, unknown>;

interface RequestState {
  /** Once set, nothing more is sent for this request. */
  cancelled: boolean;
  controller: AbortController;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface McpServerOptions {
  input: Readable;
  output: Writable;
  /** whodunit's own version, reported as serverInfo. */
  version: string;
}

/**
 * Serve MCP over newline-delimited JSON-RPC until `input` closes.
 *
 * Requests are handled concurrently and answered as they finish, so a quick
 * `tools/list` is not stuck behind a long search. Resolves when the input
 * ends; the caller decides what to do about requests still running.
 */
export function serveMcp(options: McpServerOptions): Promise<void> {
  const { input, output, version } = options;
  const serverInfo = { name: "whodunit", version };

  /** Requests still running, so a cancellation can find and stop them. */
  const inFlight = new Map<Id, RequestState>();

  // stdout carries nothing but protocol messages. JSON.stringify escapes any
  // newline inside a string, so each message is exactly one line.
  const send = (message: object) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const handleRequest = async (id: Id, method: string, params: Params) => {
    const state: RequestState = { cancelled: false, controller: new AbortController() };
    inFlight.set(id, state);
    try {
      const result = await dispatch(method, params, state);
      if (!state.cancelled) send({ id, result });
    } catch (error) {
      if (state.cancelled) return;
      if (error instanceof RpcError) {
        send({
          id,
          error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) },
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        send({ id, error: { code: INTERNAL_ERROR, message } });
      }
    } finally {
      inFlight.delete(id);
    }
  };

  const dispatch = async (method: string, params: Params, state: RequestState) => {
    if (method === "initialize") return initialize(params);

    const meta = isObject(params._meta) ? params._meta : {};
    const modern = method === "server/discover" || META_VERSION in meta;
    if (modern) checkModernMeta(meta);
    // Modern results say what kind of result they are and who sent them.
    // Legacy clients expect neither field.
    const wrap = (result: object) =>
      modern ? { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: serverInfo } } : result;

    switch (method) {
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: { tools: {} },
          _meta: { [META_SERVER_INFO]: serverInfo },
          instructions: INSTRUCTIONS,
        };
      case "ping":
        return wrap({});
      case "tools/list":
        return wrap({
          tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
            name,
            title,
            description,
            inputSchema,
          })),
        });
      case "tools/call":
        return wrap(await callTool(params, meta, state));
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  /** Legacy handshake. Answers with the client's version if we speak it. */
  const initialize = (params: Params) => {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && (LEGACY_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LEGACY_VERSIONS[0];
    return { protocolVersion, capabilities: { tools: {} }, serverInfo, instructions: INSTRUCTIONS };
  };

  const checkModernMeta = (meta: Record<string, unknown>) => {
    const requested = meta[META_VERSION];
    if (typeof requested !== "string" || !isObject(meta[META_CAPABILITIES])) {
      throw new RpcError(
        INVALID_PARAMS,
        `Missing required _meta fields "${META_VERSION}" and "${META_CAPABILITIES}".`,
      );
    }
    if (!(MODERN_VERSIONS as readonly string[]).includes(requested)) {
      throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        requested,
      });
    }
  };

  const callTool = async (params: Params, meta: Record<string, unknown>, state: RequestState) => {
    const tool = TOOLS.find((candidate) => candidate.name === params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      throw new RpcError(INVALID_PARAMS, '"arguments" must be an object.');
    }

    const token = meta.progressToken;
    let progress = 0;
    let done = false;
    const context = {
      signal: state.controller.signal,
      progress(message: string) {
        // Only while the request is live, and only if the client asked.
        if (done || state.cancelled || (typeof token !== "string" && typeof token !== "number")) return;
        send({
          method: "notifications/progress",
          params: { progressToken: token, progress: ++progress, message },
        });
      },
    };

    try {
      const result = await tool.run(params.arguments ?? {}, context);
      // Structured for clients that read it, serialized for those that only
      // pass text to the model, as the spec recommends.
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      };
    } catch (error) {
      // Bad arguments and failures such as "not a git repository" go back to
      // the model as a tool error it can read and act on.
      const message = error instanceof Error ? error.message : String(error);
      const text = error instanceof ToolInputError ? `Invalid arguments: ${message}` : message;
      return { content: [{ type: "text", text }], isError: true };
    } finally {
      done = true;
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    lines.on("line", (line) => {
      if (line.trim() === "") return;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        return;
      }

      if (!isObject(message) || message.jsonrpc !== "2.0") {
        const id = isObject(message) && (typeof message.id === "string" || typeof message.id === "number")
          ? message.id
          : null;
        send({ id, error: { code: INVALID_REQUEST, message: "Invalid request" } });
        return;
      }

      const { id, method } = message;
      const params = isObject(message.params) ? message.params : {};

      // A response from the client: we never send requests, so ignore it.
      if (typeof method !== "string") return;

      // A notification: no reply, ever.
      if (id === undefined) {
        if (method === "notifications/cancelled") {
          // Silence the request and stop its work: the abort kills the
          // running test and removes the sandbox. No response is sent.
          const target = inFlight.get(params.requestId as Id);
          if (target) {
            target.cancelled = true;
            target.controller.abort();
          }
        }
        return;
      }

      if (typeof id !== "string" && typeof id !== "number") {
        send({ id: null, error: { code: INVALID_REQUEST, message: "Request id must be a string or number" } });
        return;
      }

      void handleRequest(id, method, params);
    });

    lines.on("close", () => resolve());
  });
}
