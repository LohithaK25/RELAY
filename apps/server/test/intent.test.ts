import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShoppingIntent } from "@relay/shared";
import { ShoppingIntentSchema } from "@relay/shared";
import { ShoppingIntentService, normalizeExplicitINRBudget } from "../src/ai/intent-service.js";
import type { AIProvider } from "../src/ai/provider.js";
import { InvalidAIOutputError } from "../src/ai/provider.js";
import { validateGeminiShoppingIntent } from "../src/ai/gemini/provider.js";
import { buildIntentPrompt } from "../src/ai/gemini/prompts.js";
import { createAgentIntentHandler } from "../src/routes/agent.js";
import type { Request, Response } from "express";

const exampleIntent: ShoppingIntent = {
  originalRequest: "Find a laptop",
  category: "electronics",
  productType: "laptop",
  budget: { amount: 120_000, currency: "INR" },
  requiredAttributes: ["32GB RAM"],
  preferredAttributes: ["good battery life"],
  excludedAttributes: [],
  deliveryRequirement: "this week",
  quantity: 1,
  location: null,
  country: null,
  additionalPreferences: []
};

describe("ShoppingIntent", () => {
  it("normalizes explicit Indian rupee lakh budgets", () => {
    assert.deepEqual(normalizeExplicitINRBudget("under ₹1.2 lakh"), {
      amount: 120_000,
      currency: "INR"
    });
    assert.equal(normalizeExplicitINRBudget("I previously bought a phone for ₹1.2 lakh"), undefined);
  });

  it("validates the structured intent and rejects missing fields", () => {
    assert.equal(ShoppingIntentSchema.safeParse(exampleIntent).success, true);
    assert.equal(ShoppingIntentSchema.safeParse({ ...exampleIntent, quantity: 0 }).success, false);
  });

  it("rejects malformed or schema-invalid Gemini output", () => {
    assert.throws(() => validateGeminiShoppingIntent('{"productType":"laptop"}'), InvalidAIOutputError);
    assert.throws(() => validateGeminiShoppingIntent("not json"), InvalidAIOutputError);
  });

  it("keeps broad product-use descriptions out of strict required attributes", () => {
    const prompt = buildIntentPrompt("Find a development laptop with 32GB RAM");

    assert.match(prompt, /broad product-use descriptions/);
    assert.match(prompt, /Reserve requiredAttributes for explicit, verifiable specifications/);
  });

  it("rejects an empty request before calling the provider", async () => {
    const provider: AIProvider = {
      async parseShoppingIntent() {
        assert.fail("Provider should not be called for an empty request");
      }
    };
    const service = new ShoppingIntentService(provider);
    await assert.rejects(() => service.parse("  "), { code: "EMPTY_REQUEST" });
  });
});

describe("POST /api/agent/intent", () => {
  const provider: AIProvider = {
    async parseShoppingIntent(text) {
      return { ...exampleIntent, originalRequest: text };
    }
  };
  const handler = createAgentIntentHandler(provider);

  async function invokeHandler(body: unknown) {
    const result = { statusCode: 200, body: undefined as unknown };
    const response = {
      status(code: number) {
        result.statusCode = code;
        return this;
      },
      json(value: unknown) {
        result.body = value;
        return this;
      }
    };
    await handler(
      { body } as Request,
      response as Response,
      () => undefined
    );
    return result;
  }

  it("returns a validated intent from the mocked provider", async () => {
    const response = await invokeHandler({ request: "Find a development laptop under ₹1.2 lakh" });
    const body = response.body as { success: boolean; intent: ShoppingIntent; events: Array<{ type: string }> };

    assert.equal(response.statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(body.intent.originalRequest, "Find a development laptop under ₹1.2 lakh");
    assert.deepEqual(body.events.map((event) => event.type), ["REQUEST_RECEIVED", "INTENT_PARSED"]);
  });

  it("returns a structured validation error for an empty request", async () => {
    const response = await invokeHandler({ request: "" });
    const body = response.body as { success: boolean; error: { code: string } };

    assert.equal(response.statusCode, 400);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "EMPTY_REQUEST");
  });
});
