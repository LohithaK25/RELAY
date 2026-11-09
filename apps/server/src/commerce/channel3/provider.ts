import type { ShoppingIntent } from "@relay/shared";
import type { CommerceProvider } from "../provider.js";
import {
  CommerceProviderError,
  CommerceTimeoutError,
  InvalidCommerceResponseError
} from "../provider.js";
import { buildCommerceQuery } from "../search.js";
import { OfficialChannel3SearchClient, type Channel3SearchClient } from "./client.js";
import { mapChannel3Products } from "./mapper.js";
import { channel3SearchResponseSchema } from "./schemas.js";

const SEARCH_TIMEOUT_MS = Number(process.env.CHANNEL3_TIMEOUT_MS ?? 12_000);
const MAX_CHANNEL3_RESULTS = 20;

export class Channel3CommerceProvider implements CommerceProvider {
  constructor(
    private readonly client: Channel3SearchClient = new OfficialChannel3SearchClient(),
    private readonly timeoutMs = SEARCH_TIMEOUT_MS
  ) {}

  async search(intent: ShoppingIntent) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const query = buildCommerceQuery(intent);
    if (!query) {
      clearTimeout(timeoutId);
      return [];
    }

    try {
      const response = await this.client.search({
        query,
        limit: MAX_CHANNEL3_RESULTS,
        filters: { availability: ["InStock"] },
        config: { mode: "default" }
      }, controller.signal, {
        ...(intent.budget ? { currency: intent.budget.currency } : {}),
        ...(intent.country ? { country: intent.country } : {})
      });
      const parsed = channel3SearchResponseSchema.safeParse(response);
      if (!parsed.success) throw new InvalidCommerceResponseError();
      const candidates = mapChannel3Products(parsed.data.products, intent);
      if (process.env.NODE_ENV !== "production") {
        console.info("CHANNEL3_PRODUCTS_MAPPED", {
          rawProductCount: parsed.data.products.length,
          mappedCount: candidates.length,
          firstRawProductIds: parsed.data.products.slice(0, 3).map((product) => product.id),
          firstMappedProductIds: candidates.slice(0, 3).map((candidate) => candidate.product.id)
        });
      }
      return candidates;
    } catch (error) {
      if (error instanceof CommerceTimeoutError || error instanceof CommerceProviderError || error instanceof InvalidCommerceResponseError) {
        throw error;
      }
      if (controller.signal.aborted) throw new CommerceTimeoutError();
      throw new CommerceProviderError();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createChannel3CommerceProvider(): CommerceProvider {
  return new Channel3CommerceProvider();
}
