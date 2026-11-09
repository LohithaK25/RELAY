import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PolicySchema, ProductSchema, ShoppingIntentSchema } from "@relay/shared";
import type { Policy, Product, ShoppingIntent } from "@relay/shared";
import type { Request, RequestHandler, Response } from "express";
import { ProductRepository } from "../src/commerce/product-repository.js";
import { PlanRepository, PurchasePlanService } from "../src/trust/purchase-plan.js";
import type { PaymentProvider, PayPalCreateOrderInput, PayPalOrder } from "../src/payment/provider.js";
import { PaymentProviderError } from "../src/payment/provider.js";
import { PaymentExecutionService } from "../src/payment/payment-service.js";
import { PayPalClient } from "../src/payment/paypal/client.js";
import { createPayPalCaptureHandler, createPayPalOrderHandler, createPurchasePlanStatusHandler } from "../src/routes/agent.js";
import type { PolicyConfiguration } from "../src/trust/policy-types.js";

const intent: ShoppingIntent = ShoppingIntentSchema.parse({
  originalRequest: "A laptop for development under ₹500",
  category: "electronics",
  productType: "laptop",
  budget: { amount: 500, currency: "INR" },
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
  id: "channel3-payment-product",
  title: "Test laptop",
  description: "Test offer",
  imageUrl: null,
  productUrl: "https://merchant.example/laptop",
  merchant: "merchant.example",
  price: { amount: 499, currency: "INR" },
  availability: "in_stock",
  category: "electronics",
  attributes: {},
  source: "channel3"
});

function policy(): Policy {
  return PolicySchema.parse({
    maxTransactionAmount: 500,
    currency: "INR",
    maxItemPrice: 500,
    maxQuantity: 1,
    allowedCategories: [],
    blockedCategories: [],
    allowedMerchants: [],
    blockedMerchants: [],
    requireApproval: true,
    autoApproveBelow: 0
  });
}

class MockPaymentProvider implements PaymentProvider {
  orderInput: PayPalCreateOrderInput | undefined;
  createCalls = 0;
  captureCalls = 0;
  getOrderCalls = 0;
  order: PayPalOrder = {
    id: "PAYPAL-ORDER-123",
    status: "APPROVED",
    purchaseUnits: []
  };

  async createOrder(input: PayPalCreateOrderInput) {
    this.createCalls += 1;
    this.orderInput = input;
    return { id: "PAYPAL-ORDER-123", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-123" };
  }

  async captureOrder() {
    this.captureCalls += 1;
    this.order = {
      ...this.order,
      status: "COMPLETED",
      purchaseUnits: this.order.purchaseUnits.length > 0
        ? this.order.purchaseUnits
        : [{ captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: "499.00", currency: "INR" }] }]
    };
  }

  async getOrder() {
    this.getOrderCalls += 1;
    return this.order;
  }
}

function setup() {
  const products = new ProductRepository();
  products.save([product], intent);
  const plans = new PlanRepository();
  const planService = new PurchasePlanService(products, plans, {
    defaultPolicy: policy()
  } satisfies PolicyConfiguration);
  const draft = planService.create({ productId: product.id, quantity: 1, policy: {} });
  const approved = planService.approve(draft.plan.planId).plan;
  const provider = new MockPaymentProvider();
  const paymentService = new PaymentExecutionService(provider, plans, products, "http://localhost:5173");
  return { products, plans, planService, approved, provider, paymentService };
}

describe("PayPal Sandbox execution", () => {
  it("creates an order only for an approved plan using server-authoritative amount and currency", async () => {
    const { paymentService, provider, approved } = setup();
    const result = await paymentService.createOrder(approved.planId);
    assert.equal(provider.orderInput?.amount, "499.00");
    assert.equal(provider.orderInput?.currency, "INR");
    assert.equal(provider.orderInput?.purchasePlanId, approved.planId);
    assert.equal(result.plan.status, "EXECUTING");
    assert.equal(result.plan.paypalOrderId, "PAYPAL-ORDER-123");
    assert.equal(result.events[0]?.type, "PAYPAL_ORDER_CREATED");
    assert.match(result.approvalUrl ?? "", /sandbox\.paypal\.com/);
  });

  it("rejects a plan that has not been approved", async () => {
    const products = new ProductRepository();
    products.save([product], intent);
    const plans = new PlanRepository();
    const draft = new PurchasePlanService(products, plans, { defaultPolicy: policy() })
      .create({ productId: product.id, quantity: 1, policy: {} }).plan;
    const provider = new MockPaymentProvider();
    const service = new PaymentExecutionService(provider, plans, products);
    await assert.rejects(service.createOrder(draft.planId));
    assert.equal(provider.orderInput, undefined);
  });

  it("cannot create a PayPal order for a quantity rejected by policy", async () => {
    const products = new ProductRepository();
    products.save([product], ShoppingIntentSchema.parse({ ...intent, quantity: 10 }));
    const plans = new PlanRepository();
    const rejected = new PurchasePlanService(products, plans, { defaultPolicy: policy() })
      .create({ productId: product.id, quantity: 10, policy: {} }).plan;
    const provider = new MockPaymentProvider();
    const service = new PaymentExecutionService(provider, plans, products);

    assert.equal(rejected.status, "POLICY_REJECTED");
    await assert.rejects(service.createOrder(rejected.planId));
    assert.equal(provider.createCalls, 0);
    assert.equal(provider.orderInput, undefined);
  });

  it("ignores browser-supplied amount and currency fields", async () => {
    const { paymentService, approved, provider } = setup();
    await paymentService.createOrder(approved.planId);
    assert.equal(provider.orderInput?.amount, "499.00");
    assert.equal(provider.orderInput?.currency, "INR");
  });

  it("rejects a mismatched PayPal order ID", async () => {
    const { paymentService, approved, provider } = setup();
    await paymentService.createOrder(approved.planId);
    await assert.rejects(paymentService.capture(approved.planId, "OTHER-ORDER"));
    assert.equal(provider.captureCalls, 0);
  });

  it("verifies the PayPal capture before completing the plan", async () => {
    const { paymentService, approved, provider, plans } = setup();
    const order = await paymentService.createOrder(approved.planId);
    const result = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    assert.equal(result.plan.status, "COMPLETED");
    assert.deepEqual(result.plan.authoritativeTotal, { amount: 499, currency: "INR" });
    assert.equal(result.plan.totalMinor, 49_900);
    assert.equal(result.plan.paypalCaptureId, "CAPTURE-1");
    assert.ok(result.plan.completedAt);
    assert.deepEqual(result.events.map((event) => event.type), [
      "PAYPAL_BUYER_APPROVED",
      "PAYPAL_CAPTURE_STARTED",
      "PAYPAL_CAPTURED",
      "PAYMENT_VERIFICATION_PASSED",
      "PURCHASE_COMPLETED"
    ]);
    assert.deepEqual(
      plans.getEvents(approved.planId).map((event) => event.type),
      [
        "POLICY_CHECK_STARTED",
        "POLICY_CHECK_PASSED",
        "PURCHASE_PLAN_CREATED",
        "PURCHASE_PLAN_READY",
        "AWAITING_APPROVAL",
        "USER_APPROVAL_REQUIRED",
        "USER_APPROVED",
        "PAYPAL_ORDER_CREATED",
        "PAYPAL_APPROVAL_REQUIRED",
        "PAYPAL_BUYER_APPROVED",
        "PAYPAL_CAPTURE_STARTED",
        "PAYPAL_CAPTURED",
        "PAYMENT_VERIFICATION_PASSED",
        "PURCHASE_COMPLETED"
      ]
    );
    assert.equal(provider.getOrderCalls, 2);
  });

  it("moves a failed capture to FAILED", async () => {
    const { paymentService, approved, provider } = setup();
    const order = await paymentService.createOrder(approved.planId);
    provider.captureOrder = async () => {
      provider.captureCalls += 1;
      provider.order = { ...provider.order, status: "PAYER_ACTION_REQUIRED" };
    };
    const result = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    assert.equal(result.plan.status, "FAILED");
    assert.equal(result.failure?.code, "PAYMENT_VERIFICATION_FAILED");
  });

  it("fails verification when PayPal reports a different captured amount", async () => {
    const { paymentService, approved, provider } = setup();
    const order = await paymentService.createOrder(approved.planId);
    provider.order = {
      ...provider.order,
      purchaseUnits: [{ captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: "498.99", currency: "INR" }] }]
    };
    const result = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    assert.equal(result.plan.status, "FAILED");
    assert.equal(result.failure?.code, "PAYMENT_VERIFICATION_FAILED");
    assert.match(result.plan.paymentFailureReason ?? "", /does not match/);
  });

  it("treats a duplicate capture after completion idempotently without capturing twice", async () => {
    const { paymentService, approved, provider } = setup();
    const order = await paymentService.createOrder(approved.planId);
    await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    const duplicate = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    assert.equal(duplicate.plan.status, "COMPLETED");
    assert.deepEqual(duplicate.events, []);
    assert.equal(provider.captureCalls, 1);
  });

  it("serves authoritative transaction status without issuing another capture", async () => {
    const { paymentService, approved, provider } = setup();
    const order = await paymentService.createOrder(approved.planId);
    const capture = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    const handler = createPurchasePlanStatusHandler(paymentService);
    const result = await invoke(handler, {}, { planId: approved.planId });
    const body = result.body as {
      plan: { status: string; totalMinor: number; currency: string; paypalCaptureId: string };
      product: Product;
      events: Array<{ type: string }>;
    };

    assert.equal(result.statusCode, 200);
    assert.equal(body.plan.status, "COMPLETED");
    assert.equal(body.plan.totalMinor, 49_900);
    assert.equal(body.plan.currency, "INR");
    assert.equal(body.plan.paypalCaptureId, "CAPTURE-1");
    assert.equal(body.product.id, product.id);
    assert.ok(body.events.some((event) => event.type === "PAYMENT_VERIFICATION_PASSED"));
    assert.equal(provider.captureCalls, 1);
    assert.equal(capture.plan.status, "COMPLETED");
  });

  it("recovers a completed PayPal capture from a read-only status refresh", async () => {
    const { paymentService, approved, provider } = setup();
    await paymentService.createOrder(approved.planId);
    provider.order = {
      ...provider.order,
      status: "COMPLETED",
      purchaseUnits: [{ captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: "499.00", currency: "INR" }] }]
    };
    const refreshed = await paymentService.getTransactionStatus(approved.planId);

    assert.equal(refreshed?.plan.status, "COMPLETED");
    assert.equal(refreshed?.plan.paypalCaptureId, "CAPTURE-1");
    assert.ok(refreshed?.events.some((event) => event.type === "PAYMENT_VERIFICATION_PASSED"));
    assert.equal(provider.getOrderCalls, 1);
    assert.equal(provider.captureCalls, 0);
  });

  it("keeps an inconclusive capture pending and refreshes without recapturing", async () => {
    const { paymentService, approved, provider } = setup();
    const order = await paymentService.createOrder(approved.planId);
    provider.order = {
      id: order.plan.paypalOrderId!,
      status: "APPROVED",
      purchaseUnits: []
    };
    provider.captureOrder = async () => {
      provider.captureCalls += 1;
      throw new PaymentProviderError();
    };

    const result = await paymentService.capture(approved.planId, order.plan.paypalOrderId!);
    assert.equal(result.plan.status, "EXECUTING");
    assert.equal(result.failure?.code, "PAYMENT_FAILED");
    assert.ok(result.events.some((event) => event.type === "PAYMENT_STATUS_PENDING"));
    const refreshed = await paymentService.getTransactionStatus(approved.planId);
    assert.equal(refreshed?.plan.status, "EXECUTING");
    assert.equal(provider.captureCalls, 1);
    assert.equal(provider.getOrderCalls, 3);
  });

  it("reuses the existing PayPal order for duplicate order requests", async () => {
    const { paymentService, approved, provider } = setup();
    await paymentService.createOrder(approved.planId);
    await paymentService.createOrder(approved.planId);
    assert.equal(provider.createCalls, 1);
    assert.equal(provider.orderInput?.requestId, approved.planId);
    assert.equal(provider.orderInput?.amount, "499.00");
    assert.equal((await paymentService.createOrder(approved.planId)).approvalUrl, provider.orderInput ? "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-123" : undefined);
  });

  it("returns a structured configuration error when PayPal credentials are missing", async () => {
    const client = new PayPalClient({ baseUrl: "https://api-m.sandbox.paypal.com" });
    const { plans, products, approved } = setup();
    const service = new PaymentExecutionService(client, plans, products);
    const result = await invoke(createPayPalOrderHandler(service), { purchasePlanId: approved.planId });
    const body = result.body as { error: { code: string }; events: Array<{ type: string }> };
    assert.equal(result.statusCode, 503);
    assert.equal(body.error.code, "PAYPAL_NOT_CONFIGURED");
    assert.deepEqual(body.events.map((event) => event.type), ["PAYPAL_ORDER_FAILED"]);
  });

  it("refuses a live PayPal API base URL", async () => {
    const client = new PayPalClient({
      clientId: "sandbox-client",
      clientSecret: "sandbox-secret",
      baseUrl: "https://api-m.paypal.com"
    });
    await assert.rejects(client.createOrder({
      purchasePlanId: "a0b1c2d3-e4f5-4678-9012-abcdefabcdef",
      amount: "499.00",
      currency: "INR",
      description: "Test product",
      returnUrl: "http://localhost:5173/?paypal=success",
      cancelUrl: "http://localhost:5173/?paypal=cancel",
      requestId: "a0b1c2d3-e4f5-4678-9012-abcdefabcdef"
    }));
  });

  it("rejects client amount/currency overrides and mismatched capture IDs at the API boundary", async () => {
    const { paymentService, approved } = setup();
    const orderHandler = createPayPalOrderHandler(paymentService);
    const invalidOrder = await invoke(orderHandler, { purchasePlanId: approved.planId, amount: 1, currency: "USD" });
    assert.equal(invalidOrder.statusCode, 400);
    const captureHandler = createPayPalCaptureHandler(paymentService);
    const invalidCapture = await invoke(captureHandler, { purchasePlanId: approved.planId, paypalOrderId: "bad!", amount: 1 });
    assert.equal(invalidCapture.statusCode, 400);
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
