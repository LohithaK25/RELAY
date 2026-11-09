import { ShoppingIntentSchema, type ShoppingIntent } from "@relay/shared";
import type { AIProvider } from "../provider.js";
import { AIConfigurationError, AIProviderError, InvalidAIOutputError } from "../provider.js";
import { GoogleGeminiClient, type GeminiClient } from "./client.js";

export function validateGeminiShoppingIntent(responseText: string): ShoppingIntent {
  const parseStartedAt = performance.now();
  let output: unknown;
  try {
    output = JSON.parse(responseText);
  } catch {
    logIntentTiming("INTENT_JSON_PARSE_COMPLETED", performance.now() - parseStartedAt, false);
    throw new InvalidAIOutputError();
  }
  logIntentTiming("INTENT_JSON_PARSE_COMPLETED", performance.now() - parseStartedAt, true);

  const validationStartedAt = performance.now();
  const result = ShoppingIntentSchema.safeParse(output);
  logIntentTiming("INTENT_ZOD_VALIDATION_COMPLETED", performance.now() - validationStartedAt, result.success);
  if (!result.success) throw new InvalidAIOutputError();
  return result.data;
}

function logIntentTiming(stage: string, durationMs: number, success: boolean): void {
  if (process.env.NODE_ENV !== "production") {
    console.info(stage, { durationMs: Math.round(durationMs), success });
  }
}

export class GeminiAIProvider implements AIProvider {
  constructor(private readonly client: GeminiClient) {}

  async parseShoppingIntent(request: string): Promise<ShoppingIntent> {
    try {
      const response = await this.client.generateShoppingIntent(request);
      return validateGeminiShoppingIntent(response);
    } catch (error) {
      if (error instanceof AIConfigurationError || error instanceof InvalidAIOutputError || error instanceof AIProviderError) throw error;
      throw new AIProviderError();
    }
  }
}

export function createGeminiAIProvider(
  apiKey: string | undefined = process.env.GEMINI_API_KEY,
  model: string = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash"
): AIProvider {
  return new GeminiAIProvider(new GoogleGeminiClient(apiKey, model));
}
