import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PolicySchema, ProductCandidateSchema, ProductSchema, ShoppingIntentSchema } from "@relay/shared";
import type { Policy, Product, ShoppingIntent } from "@relay/shared";
import type { Request, RequestHandler, Response } from "express";
import { ProductRepository } from "../src/commerce/product-repository.js";
import { assertCurrencyMatch, calculateTotalMinor, compareMinor, MoneyError, minorToMajor, parseMajorToMinor } from "../src/trust/money.js";
import { evaluatePolicy } from "../src/trust/policy-engine.js";
import {
  PlanNotApprovableError,
  PlanRepository,
  ProductNotVerifiedError,
  PurchasePlanService,
  PurchaseQuantityMismatchError
} from "../src/trust/purchase-plan.js";
import { createAgentProductsHandler, createApprovePurchasePlanHandler, createPurchasePlanHandler } from "../src/routes/agent.js";
import type { CommerceProvider } from "../src/commerce/provider.js";
import type { PolicyConfiguration } from "../src/trust/policy-types.js";

const intent: ShoppingIntent = ShoppingIntentSchema.parse({
  originalRequest: "Find a laptop under ₹1.2 lakh",
  category: "electronics",
  productType: "laptop",
  budget: { amount: 120_000, currency: "INR" },
  requiredAttributes: [],
  preferredAttributes: [],
  excludedAttributes: [],
  deliveryRequirement: null,
  quantity: 1,
  location: null,
  country: null,
  additionalPreferences: []
});

const product: Product = ProductSchema.parse({
  id: "channel3-product-verified",
  title: "Verified development laptop",
  description: "A Channel3 product",
  imageUrl: null,
  productUrl: "https://merchant.example/products/laptop",
  merchant: "merchant.example",
  price: { amount: 100_000, currency: "INR" },
  availability: "in_stock",
  category: "electronics",
  attributes: { memory: "32GB RAM" },
  source: "channel3"
});

function policy(overrides: Partial<Policy> = {}): Policy {
  return PolicySchema.parse({
    maxTransactionAmount: 120_000,
    currency: "INR",
    maxItemPrice: 120_000,
    maxQuantity: 1,
    allowedCategories: [],
    blockedCategories: [],
    allowedMerchants: [],
    blockedMerchants: [],
    requireApproval: true,
    autoApproveBelow: 0,
    ...overrides
  });
}

function evaluate(overrides: {
  product?: Product;
  quantity?: number;
  policy?: Policy;
} = {}) {
  return evaluatePolicy({
    intent,
    product: overrides.product ?? product,
    quantity: overrides.quantity ?? 1,
    policy: overrides.policy ?? policy()
  }, "2026-01-01T00:00:00.000Z").decision;
}

describe("money utilities", () => {
  it("converts INR to integer paise and back", () => {
    assert.equal(parseMajorToMinor(120_000, "INR"), 12_000_000);
    assert.equal(parseMajorToMinor(120_000.5, "INR"), 12_000_050);
    assert.equal(minorToMajor(12_000_050, "INR"), 120_000.5);
  });

  it("calculates totals with integer minor units without floating-point rounding", () => {
    const unitPriceMinor = parseMajorToMinor(0.1, "INR");
    const total = calculateTotalMinor(unitPriceMinor, 3);
    assert.equal(unitPriceMinor, 10);
    assert.equal(total, 30);
    assert.equal(minorToMajor(total, "INR"), 0.3);
    assert.equal(compareMinor(total, 30), 0);
  });

  it("rejects amounts with precision beyond currency minor units and currency mismatch", () => {
    assert.throws(() => parseMajorToMinor(1.001, "INR"), MoneyError);
    assert.throws(() => assertCurrencyMatch("INR", "USD"), MoneyError);
  });
});

describe("deterministic policy engine", () => {
  it("allows products within transaction and item limits", () => {
    const decision = evaluate();
    assert.equal(decision.allowed, true);
    assert.equal(decision.checks.find((item) => item.name === "TRANSACTION_LIMIT")?.passed, true);
  });

  it("rejects a total above the transaction limit", () => {
    const decision = evaluate({ quantity: 2, policy: policy({ maxQuantity: 2, maxTransactionAmount: 150_000 }) });
    assert.equal(decision.allowed, false);
    assert.equal(decision.checks.find((item) => item.name === "TRANSACTION_LIMIT")?.passed, false);
  });

  it("rejects a unit price above the item limit", () => {
    const decision = evaluate({ policy: policy({ maxItemPrice: 99_999 }) });
    assert.equal(decision.allowed, false);
    assert.equal(decision.checks.find((item) => item.name === "ITEM_PRICE_LIMIT")?.passed, false);
  });

  it("rejects quantities above the configured limit", () => {
    const decision = evaluate({ quantity: 2 });
    assert.equal(decision.allowed, false);
    assert.equal(decision.checks.find((item) => item.name === "QUANTITY_LIMIT")?.passed, false);
  });

  it("rejects blocked categories and categories outside the allowlist", () => {
    assert.equal(evaluate({ policy: policy({ blockedCategories: ["electronics"] }) }).allowed, false);
    assert.equal(evaluate({ policy: policy({ allowedCategories: ["home"] }) }).allowed, false);
    assert.equal(evaluate({ policy: policy({ allowedCategories: ["electronics"] }) }).allowed, true);
  });

  it("rejects blocked and disallowed merchants and permits allowed merchants", () => {
    assert.equal(evaluate({ policy: policy({ blockedMerchants: ["merchant.example"] }) }).allowed, false);
    assert.equal(evaluate({ policy: policy({ allowedMerchants: ["other.example"] }) }).allowed, false);
    assert.equal(evaluate({ policy: policy({ allowedMerchants: ["www.merchant.example"] }) }).allowed, true);
  });

  it("requires explicit approval and returns stable decisions for the same input", () => {
    const first = evaluate();
    const second = evaluate();
    assert.equal(first.requiresApproval, true);
    assert.equal(first.checks.find((item) => item.name === "APPROVAL_REQUIRED")?.passed, true);
    assert.deepEqual(first, second);
  });

  it("rejects a product with incompatible price currency", () => {
    const mismatchedProduct = ProductSchema.parse({
      ...product,
      price: { amount: 10, currency: "USD" }
    });
    assert.equal(evaluate({ product: mismatchedProduct }).allowed, false);
  });
});

describe("purchase plan service", () => {
  function createService(searchIntent = intent) {
    const products = new ProductRepository();
    products.save([product], searchIntent);
    const plans = new PlanRepository();
    const configuration: PolicyConfiguration = { defaultPolicy: policy() };
    return { products, plans, service: new PurchasePlanService(products, plans, configuration) };
  }

  it("uses the server-side product price, merchant and currency", () => {
    const { service } = createService();
    const result = service.create({
      productId: product.id,
      quantity: 1,
      policy: {
        currency: "USD",
        maxTransactionAmount: 999_999,
        maxItemPrice: 999_999,
        maxQuantity: 20,
        requireApproval: false
      }
    });

    assert.equal(result.plan.authoritativeUnitPrice.amount, 100_000);
    assert.equal(result.plan.authoritativeUnitPrice.currency, "INR");
    assert.equal(result.plan.merchant, "merchant.example");
    assert.equal(result.plan.totalMinor, 10_000_000);
    assert.equal(result.plan.status, "AWAITING_APPROVAL");
    assert.equal(result.plan.policyDecision.requiresApproval, true);
    assert.deepEqual(result.events.map((event) => event.type), [
      "POLICY_CHECK_STARTED",
      "POLICY_CHECK_PASSED",
      "PURCHASE_PLAN_CREATED",
      "PURCHASE_PLAN_READY",
      "AWAITING_APPROVAL",
      "USER_APPROVAL_REQUIRED"
    ]);
  });

  it("rejects unknown products not present in the server repository", () => {
    const { service } = createService();
    assert.throws(() => service.create({
      productId: "invented-id",
      quantity: 1,
      policy: {}
    }), ProductNotVerifiedError);
  });

  it("rejects quantity tampering through the configured quantity limit", () => {
    const { service } = createService(ShoppingIntentSchema.parse({ ...intent, quantity: 2 }));
    const result = service.create({ productId: product.id, quantity: 2, policy: { maxQuantity: 99 } });
    assert.equal(result.plan.status, "POLICY_REJECTED");
    assert.equal(result.plan.quantity, 2);
    assert.equal(result.plan.policyDecision.allowed, false);
    assert.match(result.plan.policyDecision.checks.find((item) => item.name === "QUANTITY_LIMIT")?.message ?? "", /limit of 1/);
  });

  it("preserves a requested quantity above policy and calculates its full authoritative total", () => {
    const tenItemIntent = ShoppingIntentSchema.parse({ ...intent, quantity: 10 });
    const { service } = createService(tenItemIntent);
    const result = service.create({ productId: product.id, quantity: tenItemIntent.quantity, policy: {} });

    assert.equal(result.plan.quantity, 10);
    assert.equal(result.plan.authoritativeUnitPrice.amount, 100_000);
    assert.equal(result.plan.totalMinor, 100_000_000);
    assert.equal(result.plan.authoritativeTotal.amount, 1_000_000);
    assert.equal(result.plan.status, "POLICY_REJECTED");
    assert.equal(result.plan.policyDecision.allowed, false);
    assert.match(result.plan.policyDecision.checks.find((item) => item.name === "QUANTITY_LIMIT")?.message ?? "", /limit of 1/);
    assert.deepEqual(result.events.map((event) => event.type), [
      "POLICY_CHECK_STARTED",
      "POLICY_CHECK_FAILED",
      "PURCHASE_BLOCKED"
    ]);
    assert.match(result.events[2]?.message ?? "", /requested quantity 10 exceeds the configured limit of 1/i);
    assert.ok(!result.events.some((event) => event.type === "PURCHASE_PLAN_CREATED"));
  });

  it("rejects a purchase request quantity that differs from the verified intent", () => {
    const { service } = createService(ShoppingIntentSchema.parse({ ...intent, quantity: 10 }));
    assert.throws(() => service.create({ productId: product.id, quantity: 1, policy: {} }), PurchaseQuantityMismatchError);
  });

  it("does not allow a policy-rejected plan to be approved", () => {
    const { service } = createService(ShoppingIntentSchema.parse({ ...intent, quantity: 10 }));
    const rejected = service.create({ productId: product.id, quantity: 10, policy: {} });
    assert.throws(() => service.approve(rejected.plan.planId), PlanNotApprovableError);
  });

  it("does not allow a client policy to bypass server limits or required approval", () => {
    const { service } = createService();
    const result = service.create({
      productId: product.id,
      quantity: 1,
      policy: {
        maxTransactionAmount: 999_999,
        maxItemPrice: 999_999,
        maxQuantity: 999,
        requireApproval: false,
        autoApproveBelow: 999_999,
        allowedCategories: [],
        blockedCategories: []
      }
    });
    assert.equal(result.plan.policyDecision.requiresApproval, true);
    assert.equal(result.plan.status, "AWAITING_APPROVAL");
  });

  it("moves an awaiting plan to approved without initiating payment", () => {
    const { service } = createService();
    const created = service.create({ productId: product.id, quantity: 1, policy: {} });
    const approved = service.approve(created.plan.planId);
    assert.equal(approved.plan.status, "APPROVED");
    assert.equal(approved.events[0]?.type, "USER_APPROVED");
    assert.match(approved.events[0]?.message ?? "", /Payment execution is ready/);
  });
});

describe("purchase plan API handler", () => {
  function createHandler() {
    const products = new ProductRepository();
    products.save([product], intent);
    const service = new PurchasePlanService(products, new PlanRepository(), { defaultPolicy: policy() });
    return createPurchasePlanHandler(service);
  }

  it("ignores client-supplied price, merchant and currency", async () => {
    const handler = createHandler();
    const result = await invoke(handler, {
      productId: product.id,
      quantity: 1,
      policy: {},
      price: 0.01,
      merchant: "attacker.example",
      currency: "USD"
    });
    const body = result.body as { plan: { authoritativeUnitPrice: { amount: number; currency: string }; merchant: string } };
    assert.equal(result.statusCode, 200);
    assert.equal(body.plan.authoritativeUnitPrice.amount, 100_000);
    assert.equal(body.plan.authoritativeUnitPrice.currency, "INR");
    assert.equal(body.plan.merchant, "merchant.example");
  });

  it("rejects products absent from server-side context", async () => {
    const result = await invoke(createHandler(), { productId: "unseen", quantity: 1, policy: {} });
    const body = result.body as { success: boolean; error: { code: string } };
    assert.equal(result.statusCode, 404);
    assert.equal(body.error.code, "PRODUCT_NOT_VERIFIED");
  });

  it("rejects malformed or tampered approval policy inputs", async () => {
    const result = await invoke(createHandler(), {
      productId: product.id,
      quantity: 1,
      policy: { requireApproval: "false" }
    });

    it("returns a clear error when the requested quantity was changed after verified search", async () => {
      const products = new ProductRepository();
      products.save([product], ShoppingIntentSchema.parse({ ...intent, quantity: 10 }));
      const handler = createPurchasePlanHandler(new PurchasePlanService(
        products,
        new PlanRepository(),
        { defaultPolicy: policy() }
      ));
      const result = await invoke(handler, { productId: product.id, quantity: 1, policy: {} });
      const body = result.body as { error: { code: string; message: string } };
      assert.equal(result.statusCode, 400);
      assert.equal(body.error.code, "PURCHASE_QUANTITY_MISMATCH");
      assert.match(body.error.message, /verified shopping request/);
    });

    it("creates a rejected plan without reducing the verified requested quantity", async () => {
      const products = new ProductRepository();
      products.save([product], ShoppingIntentSchema.parse({ ...intent, quantity: 10 }));
      const handler = createPurchasePlanHandler(new PurchasePlanService(
        products,
        new PlanRepository(),
        { defaultPolicy: policy() }
      ));
      const result = await invoke(handler, { productId: product.id, quantity: 10, policy: {} });
      const body = result.body as {
        plan: { quantity: number; totalMinor: number; status: string; policyDecision: { allowed: boolean } };
      };

      assert.equal(result.statusCode, 200);
      assert.equal(body.plan.quantity, 10);
      assert.equal(body.plan.totalMinor, 100_000_000);
      assert.equal(body.plan.status, "POLICY_REJECTED");
      assert.equal(body.plan.policyDecision.allowed, false);
    });
    const body = result.body as { success: boolean; error: { code: string } };
    assert.equal(result.statusCode, 400);
    assert.equal(body.error.code, "INVALID_PURCHASE_PLAN_REQUEST");
  });

  it("uses products saved by the product-search endpoint as the purchase context", async () => {
    const products = new ProductRepository();
    const plans = new PlanRepository();
    const candidate = ProductCandidateSchema.parse({ product, score: 0.9, reasoning: "Matched constraints" });
    const commerceProvider: CommerceProvider = { async search() { return [candidate]; } };
    const searchHandler = createAgentProductsHandler(commerceProvider, products);
    const searchResponse = await invoke(searchHandler, { intent });
    assert.equal(searchResponse.statusCode, 200);
    const searchBody = searchResponse.body as { products: Product[] };
    assert.deepEqual(searchBody.products.map((item) => item.id), [product.id]);
    assert.equal(products.get(product.id)?.id, searchBody.products[0]?.id);

    const planHandler = createPurchasePlanHandler(new PurchasePlanService(
      products,
      plans,
      { defaultPolicy: policy() }
    ));
    const planResponse = await invoke(planHandler, { productId: product.id, quantity: 1, policy: {} });
    const body = planResponse.body as { plan: { planId: string; status: string } };
    assert.equal(planResponse.statusCode, 200);
    assert.equal(body.plan.status, "AWAITING_APPROVAL");
  });

  it("approval endpoint records approval without creating payment data", async () => {
    const products = new ProductRepository();
    products.save([product], intent);
    const plans = new PlanRepository();
    const service = new PurchasePlanService(products, plans, { defaultPolicy: policy() });
    const created = service.create({ productId: product.id, quantity: 1, policy: {} });
    const approveHandler = createApprovePurchasePlanHandler(service);
    const approvedResponse = await invoke(approveHandler, {}, { planId: created.plan.planId });
    const body = approvedResponse.body as { plan: { status: string }; events: Array<{ type: string }> };
    assert.equal(approvedResponse.statusCode, 200);
    assert.equal(body.plan.status, "APPROVED");
    assert.deepEqual(body.events.map((event) => event.type), ["USER_APPROVED"]);
    assert.equal("payment" in body, false);
  });
});

async function invoke(handler: RequestHandler, body: unknown, params: Record<string, string> = {}) {
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
  await handler({ body, params } as Request, response as Response, () => undefined);
  return result;
}
