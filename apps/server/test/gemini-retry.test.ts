import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withGeminiRetries } from "../src/ai/gemini/client.js";

describe("Gemini transient failure retries", () => {
  it("retries 429 and 504 with bounded exponential delays", async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryEvents: Array<{ attempt: number; delayMs: number; status: number }> = [];
    const result = await withGeminiRetries(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
        if (calls === 2) throw Object.assign(new Error("deadline exceeded"), { status: 504 });
        return "valid response";
      },
      (attempt, delayMs, status) => retryEvents.push({ attempt, delayMs, status }),
      async (delayMs) => { delays.push(delayMs); }
    );

    assert.equal(result, "valid response");
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
    assert.deepEqual(retryEvents, [
      { attempt: 1, delayMs: 250, status: 429 },
      { attempt: 2, delayMs: 500, status: 504 }
    ]);
  });

  it("does not retry non-transient HTTP failures", async () => {
    let calls = 0;
    await assert.rejects(
      withGeminiRetries(async () => {
        calls += 1;
        throw Object.assign(new Error("invalid request"), { status: 400 });
      }, undefined, async () => undefined)
    );
    assert.equal(calls, 1);
  });

  it("does not retry errors without a transient HTTP status", async () => {
    let calls = 0;
    await assert.rejects(
      withGeminiRetries(async () => {
        calls += 1;
        throw new Error("malformed output");
      }, undefined, async () => undefined)
    );
    assert.equal(calls, 1);
  });

  it("stops after the initial attempt and two retries", async () => {
    let calls = 0;
    await assert.rejects(
      withGeminiRetries(async () => {
        calls += 1;
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      }, undefined, async () => undefined)
    );
    assert.equal(calls, 3);
  });
});
