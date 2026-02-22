/**
 * Real-time JSONL parser for Claude Code CLI `--output-format stream-json`.
 *
 * Each line from the CLI is a JSON object. The parser:
 * - Buffers incomplete lines (chunks may split across `onStdout` calls)
 * - Emits text deltas via `onText` callback for immediate streaming
 * - Captures `session_id` and `usage` from the `result` event
 * - Handles `content_block_delta` (text), `content_block_start` (tool_use), and `result` events
 */

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type StreamJsonCallbacks = {
  onText?: (text: string) => void;
  onToolUse?: (name: string) => void;
  onSessionId?: (id: string) => void;
  onUsage?: (usage: CliUsage) => void;
  onError?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

export function createStreamJsonParser(callbacks: StreamJsonCallbacks): {
  feed: (chunk: string) => void;
  flush: () => void;
  getCollectedText: () => string;
  getSessionId: () => string | undefined;
  getUsage: () => CliUsage | undefined;
} {
  let buffer = "";
  const collectedTextParts: string[] = [];
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";

    // content_block_delta with text_delta → emit text
    if (type === "content_block_delta" && isRecord(parsed.delta)) {
      const delta = parsed.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        collectedTextParts.push(delta.text);
        callbacks.onText?.(delta.text);
      }
      return;
    }

    // content_block_start with tool_use → emit tool name
    if (type === "content_block_start" && isRecord(parsed.content_block)) {
      const block = parsed.content_block;
      if (block.type === "tool_use" && typeof block.name === "string") {
        callbacks.onToolUse?.(block.name);
      }
      return;
    }

    // system init event (may contain session_id)
    if (type === "system" && !sessionId) {
      if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
        sessionId = parsed.session_id.trim();
        callbacks.onSessionId?.(sessionId);
      }
      return;
    }

    // result event → capture session_id, usage, error
    if (type === "result") {
      if (!sessionId && typeof parsed.session_id === "string" && parsed.session_id.trim()) {
        sessionId = parsed.session_id.trim();
        callbacks.onSessionId?.(sessionId);
      }
      if (isRecord(parsed.usage)) {
        usage = toUsage(parsed.usage) ?? usage;
        if (usage) {
          callbacks.onUsage?.(usage);
        }
      }
      // If no text was collected from deltas, use the result text as fallback
      if (
        collectedTextParts.length === 0 &&
        typeof parsed.result === "string" &&
        parsed.result.trim()
      ) {
        collectedTextParts.push(parsed.result);
        callbacks.onText?.(parsed.result);
      }
      if (parsed.is_error === true && typeof parsed.result === "string") {
        callbacks.onError?.(parsed.result);
      }
      return;
    }
  }

  return {
    feed(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Keep the last element — it may be an incomplete line
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },

    flush(): void {
      if (buffer.trim()) {
        processLine(buffer);
        buffer = "";
      }
    },

    getCollectedText(): string {
      return collectedTextParts.join("");
    },

    getSessionId(): string | undefined {
      return sessionId;
    },

    getUsage(): CliUsage | undefined {
      return usage;
    },
  };
}
