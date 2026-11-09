import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductCandidate, ShoppingIntent } from "@relay/shared";
import { ShoppingIntentSchema } from "@relay/shared";
import type { Request, Response } from "express";
import { mapChannel3Product, mapChannel3Products } from "../src/commerce/channel3/mapper.js";
import { Channel3CommerceProvider } from "../src/commerce/channel3/provider.js";
import { isChannel3CurrencySupported, type Channel3SearchClient } from "../src/commerce/channel3/client.js";
import { CommerceConfigurationError, InvalidCommerceResponseError } from "../src/commerce/provider.js";
import type { CommerceProvider } from "../src/commerce/provider.js";
import { buildCommerceQuery, filterAndRankProducts } from "../src/commerce/search.js";
import { createAgentProductsHandler } from "../src/routes/agent.js";
import { ProductRepository } from "../src/commerce/product-repository.js";

const intent: ShoppingIntent = ShoppingIntentSchema.parse({
  originalRequest: "Find a development laptop under ₹1.2 lakh with 32GB RAM and good battery life",
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
});

function rawProduct(options: {
  id?: string;
  title?: string;
  price?: number;
  currency?: string;
  availability?: "InStock" | "OutOfStock";
  features?: string[];
  url?: string;
} = {}) {
  return {
    id: options.id ?? "channel3-prod-1",
    title: options.title ?? "Developer laptop",
    description: "Laptop for development",
    category: { slug: "laptops", title: "Laptops", has_children: false },
    images: [{ url: "https://cdn.trychannel3.com/product.jpg", cleaned_url: null, is_main_image: true }],
    key_features: options.features ?? ["32GB RAM", "good battery life"],
    structured_attributes: {
      memory: options.features?.some((feature) => feature.toLowerCase().includes("32gb")) === false
        ? []
        : ["32GB RAM"],
      battery: options.features?.some((feature) => feature.toLowerCase().includes("battery"))
        ? ["good battery life"]
        : options.features === undefined ? ["good battery life"] : []
    },
    offers: [{
      url: options.url ?? "https://shop.example/products/laptop",
      domain: "www.shop.example",
      price: { price: options.price ?? 100_000, currency: options.currency ?? "INR" },
      availability: options.availability ?? "InStock"
    }]
  };
}

function candidate(product: ReturnType<typeof mapChannel3Products>[number]): ProductCandidate {
  assert.ok(product);
  return product;
}

describe("Channel3 product normalization", () => {
  it("only sends currencies supported by the installed Channel3 SDK", () => {
    assert.equal(isChannel3CurrencySupported("INR"), false);
    assert.equal(isChannel3CurrencySupported("USD"), true);
  });

  it("normalizes Channel3 data and preserves the product ID", () => {
    const mapped = mapChannel3Product(rawProduct(), intent);
    assert.ok(mapped);
    assert.equal(mapped.product.id, "channel3-prod-1");
    assert.equal(mapped.product.title, "Developer laptop");
    assert.equal(mapped.product.merchant, "shop.example");
    assert.equal(mapped.product.productUrl, "https://shop.example/products/laptop");
    assert.deepEqual(mapped.product.price, { amount: 100_000, currency: "INR" });
    assert.equal(mapped.product.availability, "in_stock");
    assert.equal(mapped.product.imageUrl, "https://cdn.trychannel3.com/product.jpg");
    assert.equal(mapped.product.source, "channel3");
  });

  it("rejects malformed Channel3 product responses", () => {
    assert.throws(() => mapChannel3Product({ id: 22, title: null }, intent), InvalidCommerceResponseError);
  });

  it("builds a provider query from the structured intent", () => {
    assert.equal(
      buildCommerceQuery(intent),
      "laptop electronics 32GB RAM good battery life 120000 INR maximum this week"
    );
  });
});

describe("deterministic product filtering and ranking", () => {
  it("filters out products above budget and with an incompatible currency", () => {
    const products = mapChannel3Products([
      rawProduct({ id: "in-budget", price: 119_000 }),
      rawProduct({ id: "over-budget", price: 120_001 }),
      rawProduct({ id: "wrong-currency", currency: "USD" }),
      rawProduct({ id: "unavailable", availability: "OutOfStock" })
    ], intent);
    assert.deepEqual(filterAndRankProducts(products, intent).map((item) => item.product.id), ["in-budget"]);
  });

  it("interprets the request budget as a total across the requested quantity", () => {
    const twoItemIntent = ShoppingIntentSchema.parse({
      ...intent,
      budget: { amount: 120_000, currency: "INR" },
      quantity: 2
    });
    const products = mapChannel3Products([
      rawProduct({ id: "total-within-budget", price: 60_000 }),
      rawProduct({ id: "total-over-budget", price: 60_001 })
    ], twoItemIntent);

    assert.deepEqual(
      filterAndRankProducts(products, twoItemIntent).map((item) => item.product.id),
      ["total-within-budget"]
    );
  });

  it("filters products that do not meet required attributes", () => {
    const products = mapChannel3Products([
      rawProduct({ id: "required-match" }),
      rawProduct({ id: "required-missing", features: ["16GB RAM"] })
    ], intent);
    assert.deepEqual(filterAndRankProducts(products, intent).map((item) => item.product.id), ["required-match"]);
  });

  it("ranks products reproducibly by preferences and price", () => {
    const products = mapChannel3Products([
      rawProduct({ id: "dear", price: 110_000, features: ["32GB RAM", "good battery life"] }),
      rawProduct({ id: "cheap", price: 80_000, features: ["32GB RAM"] }),
      rawProduct({ id: "best", price: 90_000, features: ["32GB RAM", "good battery life"] })
    ], intent);
    const first = filterAndRankProducts(products, intent).map((item) => item.product.id);
    const second = filterAndRankProducts(products, intent).map((item) => item.product.id);
    assert.deepEqual(first, ["best", "dear", "cheap"]);
    assert.deepEqual(first, second);
  });

  it("limits recommendations to the top five", () => {
    const products = mapChannel3Products(
      Array.from({ length: 7 }, (_, index) => rawProduct({ id: `product-${index}`, price: 70_000 + index * 1_000 })),
      intent
    );
    assert.equal(filterAndRankProducts(products, intent).length, 5);
  });
});

describe("Channel3 provider and POST /api/agent/products", () => {
  it("handles empty search results without inventing products", async () => {
    const client: Channel3SearchClient = {
      async search() {
        return { products: [] };
      }
    };
    const provider = new Channel3CommerceProvider(client);
    assert.deepEqual(await provider.search(intent), []);
  });

  it("rejects malformed Channel3 search responses", async () => {
    const client: Channel3SearchClient = {
      async search() {
        return { products: [{ id: "not-a-valid-product" }] };
      }
    };
    await assert.rejects(() => new Channel3CommerceProvider(client).search(intent), InvalidCommerceResponseError);
  });

  it("supports a mocked commerce provider without credentials", async () => {
    const product = candidate(mapChannel3Products([rawProduct()], intent)[0]);
    const provider: CommerceProvider = {
      async search() {
        return [product];
      }
    };
    assert.deepEqual((await provider.search(intent)).map((item) => item.product.id), ["channel3-prod-1"]);
  });

  it("validates the intent and returns normalized products from the route", async () => {
    const product = candidate(mapChannel3Products([rawProduct()], intent)[0]);
    const provider: CommerceProvider = {
      async search(receivedIntent) {
        assert.deepEqual(receivedIntent, intent);
        return [product];
      }
    };
    const handler = createAgentProductsHandler(provider, new ProductRepository());
    const result = await invokeHandler(handler, { intent });
    const body = result.body as { success: boolean; products: Array<{ id: string }>; events: Array<{ type: string; message: string }> };
    assert.equal(result.statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(body.products[0]?.id, "channel3-prod-1");
    assert.deepEqual(body.events.map((event) => event.type), [
      "PRODUCTS_DISCOVERED",
      "PRODUCTS_FILTERED",
      "PRODUCTS_RANKED"
    ]);
    assert.match(body.events[1]?.message ?? "", /retained 1 of 1/);
  });

  it("returns a structured error for invalid intent", async () => {
    const provider: CommerceProvider = { async search() { return []; } };
    const handler = createAgentProductsHandler(provider, new ProductRepository());
    const result = await invokeHandler(handler, { intent: { ...intent, quantity: 0 } });
    const body = result.body as { success: boolean; error: { code: string } };
    assert.equal(result.statusCode, 400);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_INTENT");
  });

  it("returns a developer-friendly configuration error when Channel3 is missing", async () => {
    const provider: CommerceProvider = {
      async search() {
        throw new CommerceConfigurationError();
      }
    };
    const handler = createAgentProductsHandler(provider, new ProductRepository());
    const result = await invokeHandler(handler, { intent });
    const body = result.body as { success: boolean; error: { code: string } };
    assert.equal(result.statusCode, 503);
    assert.equal(body.error.code, "COMMERCE_NOT_CONFIGURED");
  });
});

async function invokeHandler(handler: ReturnType<typeof createAgentProductsHandler>, body: unknown) {
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
  await handler({ body } as Request, response as Response, () => undefined);
  return result;
}
