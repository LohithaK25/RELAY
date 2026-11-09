import { GoogleGenAI } from "@google/genai";
import { AIConfigurationError, AIProviderError } from "../provider.js";
import { buildIntentPrompt } from "./prompts.js";
import { shoppingIntentResponseSchema } from "./schemas.js";

const GEMINI_REQUEST_TIMEOUT_MS = 20_000;
const GEMINI_MAX_RETRIES = 2;
const GEMINI_RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GeminiClient {
  generateShoppingIntent(request: string): Promise<string>;
}

export class GoogleGeminiClient implements GeminiClient {
  private client: GoogleGenAI | undefined;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string
  ) {}

  async generateShoppingIntent(request: string): Promise<string> {
    if (!this.apiKey?.trim()) throw new AIConfigurationError();

    let requestStartedAt: number | undefined;
    try {
      this.client ??= new GoogleGenAI({ apiKey: this.apiKey });
      const client = this.client;
      const promptStartedAt = performance.now();
      const prompt = buildIntentPrompt(request);
      logIntentTiming("INTENT_PROMPT_CONSTRUCTED", performance.now() - promptStartedAt);

      requestStartedAt = performance.now();
      logIntentTiming("GEMINI_REQUEST_STARTED", 0);
      const response = await withGeminiRetries(
        () => client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: shoppingIntentResponseSchema,
            httpOptions: {
              timeout: GEMINI_REQUEST_TIMEOUT_MS,
              retryOptions: { attempts: 1 }
            }
          }
        }),
        (attempt, delayMs, status) => {
          if (process.env.NODE_ENV !== "production") {
            console.info("GEMINI_RETRY_SCHEDULED", { attempt, delayMs, status });
          }
        }
      );
      logIntentTiming("GEMINI_RESPONSE_RECEIVED", performance.now() - requestStartedAt);
      if (!response.text) throw new AIProviderError();
      return response.text;
    } catch (error) {
      if (error instanceof AIConfigurationError || error instanceof AIProviderError) throw error;
      if (requestStartedAt !== undefined) {
        logIntentTiming("GEMINI_REQUEST_FAILED", performance.now() - requestStartedAt);
      }
      if (process.env.NODE_ENV !== "production") logGeminiFailure(error, this.apiKey);
      throw new AIProviderError();
    }
  }
}

export async function withGeminiRetries<T>(
  operation: () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number, status: number) => void,
  wait: (delayMs: number) => Promise<void> = delay
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = getGeminiHttpStatus(error);
      if (attempt >= GEMINI_MAX_RETRIES || status === undefined || !RETRYABLE_GEMINI_STATUSES.has(status)) {
        throw error;
      }

      const delayMs = GEMINI_RETRY_BASE_DELAY_MS * (2 ** attempt);
      onRetry?.(attempt + 1, delayMs, status);
      await wait(delayMs);
    }
  }
}

function getGeminiHttpStatus(error: unknown): number | undefined {
  const details = asRecord(error);
  const response = asRecord(details?.response);
  const nestedError = asRecord(details?.error);
  const candidates = [details?.status, details?.statusCode, response?.status, nestedError?.code];
  for (const candidate of candidates) {
    const status = typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^\d{3}$/.test(candidate)
        ? Number(candidate)
        : undefined;
    if (status !== undefined) return status;
  }
  return undefined;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function logIntentTiming(stage: string, durationMs: number): void {
  if (process.env.NODE_ENV !== "production") {
    console.info(stage, { durationMs: Math.round(durationMs) });
  }
}

function logGeminiFailure(error: unknown, apiKey: string | undefined): void {
  const details = asRecord(error);
  const response = asRecord(details?.response);
  const nestedError = asRecord(details?.error);
  const message = error instanceof Error
    ? error.message
    : typeof details?.message === "string"
      ? details.message
      : typeof nestedError?.message === "string"
        ? nestedError.message
        : String(error);
  const parsedMessage = parseJsonRecord(message);
  const apiError = asRecord(parsedMessage?.error) ?? nestedError;
  const safeText = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    return String(value)
      .replaceAll(apiKey?.trim() || "\u0000", "[REDACTED]")
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  };

  console.error("Gemini API request failed.", {
    type: safeText(details?.name) ?? (error instanceof Error ? error.constructor.name : typeof error),
    status: safeText(details?.status ?? details?.statusCode ?? response?.status ?? apiError?.code),
    code: safeText(details?.code ?? apiError?.status),
    message: safeText(message),
    responseDetails: apiError
      ? {
          code: safeText(apiError.code),
          status: safeText(apiError.status),
          message: safeText(apiError.message)
        }
      : undefined
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
