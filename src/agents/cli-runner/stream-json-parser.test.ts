import { describe, expect, it, vi } from "vitest";
import { createStreamJsonParser, type StreamJsonCallbacks } from "./stream-json-parser.js";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

describe("createStreamJsonParser", () => {
  it("emits text deltas from content_block_delta events", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    parser.feed(
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    );
    parser.feed(
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      }),
    );

    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenNthCalledWith(1, "Hello");
    expect(onText).toHaveBeenNthCalledWith(2, " world");
    expect(parser.getCollectedText()).toBe("Hello world");
  });

  it("captures session_id from system init event", () => {
    const onSessionId = vi.fn();
    const parser = createStreamJsonParser({ onSessionId });

    parser.feed(line({ type: "system", subtype: "init", session_id: "sess-123" }));

    expect(onSessionId).toHaveBeenCalledWith("sess-123");
    expect(parser.getSessionId()).toBe("sess-123");
  });

  it("captures session_id from result event when not in system init", () => {
    const onSessionId = vi.fn();
    const parser = createStreamJsonParser({ onSessionId });

    parser.feed(
      line({ type: "result", subtype: "success", session_id: "sess-456", result: "done" }),
    );

    expect(onSessionId).toHaveBeenCalledWith("sess-456");
    expect(parser.getSessionId()).toBe("sess-456");
  });

  it("prefers session_id from system init over result", () => {
    const onSessionId = vi.fn();
    const parser = createStreamJsonParser({ onSessionId });

    parser.feed(line({ type: "system", subtype: "init", session_id: "from-init" }));
    parser.feed(line({ type: "result", session_id: "from-result", result: "done" }));

    expect(parser.getSessionId()).toBe("from-init");
    expect(onSessionId).toHaveBeenCalledTimes(1);
  });

  it("captures usage from result event", () => {
    const onUsage = vi.fn();
    const parser = createStreamJsonParser({ onUsage });

    parser.feed(
      line({
        type: "result",
        session_id: "s",
        result: "ok",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
      }),
    );

    expect(onUsage).toHaveBeenCalledWith({ input: 100, output: 50, cacheRead: 200 });
    expect(parser.getUsage()).toEqual({ input: 100, output: 50, cacheRead: 200 });
  });

  it("emits tool_use from content_block_start", () => {
    const onToolUse = vi.fn();
    const parser = createStreamJsonParser({ onToolUse });

    parser.feed(
      line({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
      }),
    );

    expect(onToolUse).toHaveBeenCalledWith("Read");
  });

  it("emits error from result event with is_error", () => {
    const onError = vi.fn();
    const parser = createStreamJsonParser({ onError });

    parser.feed(
      line({
        type: "result",
        subtype: "error",
        session_id: "s",
        result: "Something went wrong",
        is_error: true,
      }),
    );

    expect(onError).toHaveBeenCalledWith("Something went wrong");
  });

  it("buffers incomplete lines across feed calls", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    const full = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    });
    // Split the line in the middle
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    expect(onText).not.toHaveBeenCalled();

    parser.feed(full.slice(mid) + "\n");
    expect(onText).toHaveBeenCalledWith("partial");
  });

  it("handles multiple events in a single chunk", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    const chunk =
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } }) +
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } });

    parser.feed(chunk);

    expect(onText).toHaveBeenCalledTimes(2);
    expect(parser.getCollectedText()).toBe("AB");
  });

  it("ignores malformed JSON lines", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    parser.feed("not json\n");
    parser.feed("{broken\n");
    parser.feed(
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    );

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("ok");
  });

  it("ignores unknown event types", () => {
    const callbacks: StreamJsonCallbacks = {
      onText: vi.fn(),
      onToolUse: vi.fn(),
      onSessionId: vi.fn(),
    };
    const parser = createStreamJsonParser(callbacks);

    parser.feed(line({ type: "message_start" }));
    parser.feed(line({ type: "content_block_stop", index: 0 }));
    parser.feed(line({ type: "message_stop" }));

    expect(callbacks.onText).not.toHaveBeenCalled();
    expect(callbacks.onToolUse).not.toHaveBeenCalled();
    expect(callbacks.onSessionId).not.toHaveBeenCalled();
  });

  it("uses result.text as fallback when no deltas were collected", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    parser.feed(line({ type: "result", session_id: "s", result: "Final answer" }));

    expect(onText).toHaveBeenCalledWith("Final answer");
    expect(parser.getCollectedText()).toBe("Final answer");
  });

  it("does not use result.text fallback when deltas were already collected", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    parser.feed(
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "streamed" },
      }),
    );
    parser.feed(line({ type: "result", session_id: "s", result: "streamed" }));

    expect(onText).toHaveBeenCalledTimes(1);
    expect(parser.getCollectedText()).toBe("streamed");
  });

  it("flush processes remaining buffer content", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    // Feed without trailing newline
    parser.feed(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "tail" },
      }),
    );
    expect(onText).not.toHaveBeenCalled();

    parser.flush();
    expect(onText).toHaveBeenCalledWith("tail");
  });

  it("handles full stream-json session end to end", () => {
    const onText = vi.fn();
    const onSessionId = vi.fn();
    const onUsage = vi.fn();
    const parser = createStreamJsonParser({ onText, onSessionId, onUsage });

    parser.feed(line({ type: "system", subtype: "init", session_id: "abc-123" }));
    parser.feed(
      line({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    parser.feed(
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    );
    parser.feed(
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", " } }),
    );
    parser.feed(
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      }),
    );
    parser.feed(line({ type: "content_block_stop", index: 0 }));
    parser.feed(line({ type: "message_stop" }));
    parser.feed(
      line({
        type: "result",
        subtype: "success",
        session_id: "abc-123",
        result: "Hello, world!",
        is_error: false,
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    );

    expect(parser.getCollectedText()).toBe("Hello, world!");
    expect(parser.getSessionId()).toBe("abc-123");
    expect(parser.getUsage()).toEqual({ input: 50, output: 10 });
    expect(onText).toHaveBeenCalledTimes(3);
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("works with no callbacks provided", () => {
    const parser = createStreamJsonParser({});

    parser.feed(line({ type: "system", subtype: "init", session_id: "s1" }));
    parser.feed(
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    );
    parser.feed(
      line({
        type: "result",
        session_id: "s1",
        result: "hi",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    expect(parser.getCollectedText()).toBe("hi");
    expect(parser.getSessionId()).toBe("s1");
    expect(parser.getUsage()).toEqual({ input: 10, output: 5 });
  });

  it("ignores non-text deltas (input_json_delta)", () => {
    const onText = vi.fn();
    const parser = createStreamJsonParser({ onText });

    parser.feed(
      line({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file' },
      }),
    );

    expect(onText).not.toHaveBeenCalled();
    expect(parser.getCollectedText()).toBe("");
  });
});
