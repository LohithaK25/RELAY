import { Channel3, Channel3Api } from "@channel3/sdk";
import {
  CommerceConfigurationError,
  CommerceProviderError,
  CommerceTimeoutError
} from "../provider.js";

export interface Channel3SearchClient {
  search(request: {
    query: string;
    limit: number;
    filters: { availability: ["InStock"] };
    config: { mode: "default" };
  }, signal: AbortSignal, locale?: { currency?: string; country?: string }): Promise<unknown>;
}

const supportedCurrencies: readonly string[] = Object.values(Channel3Api.CurrencyCode);

export function isChannel3CurrencySupported(currency: string): boolean {
  return supportedCurrencies.includes(currency);
}

export class OfficialChannel3SearchClient implements Channel3SearchClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string | undefined = process.env.CHANNEL3_API_KEY,
    baseUrl: string | undefined = process.env.CHANNEL3_BASE_URL,
    timeoutMs = Number(process.env.CHANNEL3_TIMEOUT_MS ?? 12_000)
  ) {
    this.apiKey = apiKey?.trim() || undefined;
    this.baseUrl = baseUrl?.trim() || undefined;
    this.timeoutMs = timeoutMs;
  }

  async search(request: {
    query: string;
    limit: number;
    filters: { availability: ["InStock"] };
    config: { mode: "default" };
  }, signal: AbortSignal, locale?: { currency?: string; country?: string }): Promise<unknown> {
    if (!this.apiKey) throw new CommerceConfigurationError();
    try {
      const client = new Channel3({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
        ...(locale?.currency && isChannel3CurrencySupported(locale.currency) ? { currency: locale.currency } : {}),
        ...(locale?.country ? { country: locale.country } : {}),
        timeoutInSeconds: Math.ceil(this.timeoutMs / 1000),
        maxRetries: 0
      });
      const result = await client.products.search(request, {
        timeoutInSeconds: Math.ceil(this.timeoutMs / 1000),
        maxRetries: 0,
        abortSignal: signal
      });
      if (process.env.NODE_ENV !== "production") {
        console.info("CHANNEL3_SEARCH_RESPONSE", {
          status: result.rawResponse.status,
          query: request.query,
          rawProductCount: result.data.length,
          firstProductIds: result.data.slice(0, 3).map((product) => product.id)
        });
      }
      return { products: result.data };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name.includes("Timeout"))) {
        if (process.env.NODE_ENV !== "production") logChannel3Failure(error, this.apiKey);
        throw new CommerceTimeoutError();
      }
      if (process.env.NODE_ENV !== "production") logChannel3Failure(error, this.apiKey);
      throw new CommerceProviderError();
    }
  }
}

function logChannel3Failure(error: unknown, apiKey: string): void {
  const details = asRecord(error);
  const body = sanitize(details?.body, apiKey);
  const response = asRecord(details?.rawResponse);
  const headers = asRecord(response?.headers);
  const headerGetter = headers?.get;
  const responseHeaders = typeof headerGetter === "function"
    ? {
        contentType: safeText(headerGetter.call(headers, "content-type"), apiKey),
        requestId: safeText(headerGetter.call(headers, "x-request-id"), apiKey)
      }
    : undefined;

  console.error("Channel3 product search failed.", {
    name: safeText(details?.name, apiKey) ?? (error instanceof Error ? error.constructor.name : typeof error),
    status: safeText(details?.statusCode ?? response?.status, apiKey),
    code: safeText(asRecord(body)?.code, apiKey),
    message: safeText(details?.message ?? (error instanceof Error ? error.message : String(error)), apiKey),
    responseDetails: body,
    responseHeaders
  });
}

function sanitize(value: unknown, apiKey: string, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, apiKey, depth + 1));
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return safeText(value, apiKey);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).slice(0, 40).map(([key, item]) => [
    key,
    /api.?key|authorization|secret|token/i.test(key) ? "[REDACTED]" : sanitize(item, apiKey, depth + 1)
  ]));
}

function safeText(value: unknown, apiKey: string): string | number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value)
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|ch3|key)[-_][A-Za-z0-9_-]{16,}/gi, "[REDACTED]");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
