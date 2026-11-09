import { createHash, randomUUID } from "node:crypto";
import { PurchasePlanSchema, type AgentEvent, type Product, type PurchasePlan } from "@relay/shared";
import type { ProductRepository } from "../commerce/product-repository.js";
import { assertCurrencyMatch, calculateTotalMinor, formatMinorToMajorString, MoneyError, parseMajorToMinor } from "../trust/money.js";
import type { PlanRepository } from "../trust/purchase-plan.js";
import {
  PaymentConfigurationError
} from "./provider.js";
import type { PaymentProvider } from "./provider.js";

export class PaymentPlanNotFoundError extends Error {
  constructor() {
    super("The purchase plan was not found.");
    this.name = "PaymentPlanNotFoundError";
  }
}

export class PaymentPlanStateError extends Error {
  constructor() {
    super("The purchase plan is not in a state that permits this payment action.");
    this.name = "PaymentPlanStateError";
  }
}

export class PaymentOrderMismatchError extends Error {
  constructor() {
    super("The PayPal order does not match the purchase plan.");
    this.name = "PaymentOrderMismatchError";
  }
}

export interface PaymentActionResult {
  plan: PurchasePlan;
  product?: Product;
  events: AgentEvent[];
  approvalUrl?: string;
  failure?: { code: "PAYMENT_FAILED" | "PAYMENT_VERIFICATION_FAILED"; message: string };
}

export class PaymentExecutionService {
  private readonly orderRequests = new Map<string, Promise<PaymentActionResult>>();
  private readonly captureRequests = new Map<string, Promise<PaymentActionResult>>();

  constructor(
    private readonly provider: PaymentProvider,
    private readonly plans: PlanRepository,
    private readonly products: ProductRepository,
    private readonly webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173"
  ) {}

  createOrder(planId: string): Promise<PaymentActionResult> {
    const active = this.orderRequests.get(planId);
    if (active) return active;
    const operation = this.createOrderOnce(planId).finally(() => this.orderRequests.delete(planId));
    this.orderRequests.set(planId, operation);
    return operation;
  }

  capture(planId: string, paypalOrderId: string): Promise<PaymentActionResult> {
    const active = this.captureRequests.get(planId);
    if (active) return active;
    const operation = this.captureOnce(planId, paypalOrderId).finally(() => this.captureRequests.delete(planId));
    this.captureRequests.set(planId, operation);
    return operation;
  }

  private async createOrderOnce(planId: string): Promise<PaymentActionResult> {
    const plan = this.requirePlan(planId);
    if (plan.status === "EXECUTING" && plan.paypalOrderId && plan.paypalApprovalUrl) {
      return { plan, approvalUrl: plan.paypalApprovalUrl, events: [] };
    }
    if (plan.status !== "APPROVED" || !plan.policyDecision.allowed) throw new PaymentPlanStateError();
    const product = this.verifyAuthoritativePlan(plan);
    const returnUrl = new URL("/", this.webOrigin);
    returnUrl.searchParams.set("paypal", "success");
    returnUrl.searchParams.set("planId", plan.planId);
    const cancelUrl = new URL("/", this.webOrigin);
    cancelUrl.searchParams.set("paypal", "cancel");
    cancelUrl.searchParams.set("planId", plan.planId);

    const order = await this.provider.createOrder({
      purchasePlanId: plan.planId,
      amount: formatMinorToMajorString(plan.totalMinor, plan.currency),
      currency: plan.currency,
      description: `${product.title} · ${plan.merchant}`,
      returnUrl: returnUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      requestId: plan.planId
    });
    const orderCreatedAt = new Date().toISOString();
    const executingPlan = PurchasePlanSchema.parse({
      ...plan,
      status: "EXECUTING",
      paypalOrderId: order.id,
      paypalApprovalUrl: order.approvalUrl,
      paymentFailureReason: null
    });
    this.plans.save(executingPlan);
    const events = [
      createEvent("PAYPAL_ORDER_CREATED", "A PayPal Sandbox order was created using the verified plan total.", orderCreatedAt),
      createEvent("PAYPAL_APPROVAL_REQUIRED", "Complete approval in PayPal Sandbox to continue.", new Date().toISOString())
    ];
    this.plans.appendEvents(plan.planId, events);
    return {
      plan: executingPlan,
      product,
      approvalUrl: order.approvalUrl,
      events
    };
  }

  private async captureOnce(planId: string, paypalOrderId: string): Promise<PaymentActionResult> {
    const plan = this.requirePlan(planId);
    if (plan.status === "COMPLETED" && plan.paypalOrderId === paypalOrderId) {
      return { plan, product: this.products.get(plan.productId), events: [] };
    }
    if (plan.status !== "EXECUTING" || !plan.paypalOrderId) throw new PaymentPlanStateError();
    if (plan.paypalOrderId !== paypalOrderId) throw new PaymentOrderMismatchError();
    const product = this.verifyAuthoritativePlan(plan);
    const approvalOrder = await this.provider.getOrder(plan.paypalOrderId);
    if (approvalOrder.id !== plan.paypalOrderId || approvalOrder.status !== "APPROVED") {
      throw new PaymentPlanStateError();
    }
    const events: AgentEvent[] = [
      createEvent("PAYPAL_BUYER_APPROVED", "PayPal confirmed the buyer approved this order.", new Date().toISOString())
    ];
    this.plans.appendEvents(plan.planId, events);
    const captureStartedEvent = createEvent(
      "PAYPAL_CAPTURE_STARTED",
      "RELAY is requesting capture of the buyer-approved PayPal order.",
      new Date().toISOString()
    );
    events.push(captureStartedEvent);
    this.plans.appendEvents(plan.planId, [captureStartedEvent]);
    try {
      await this.provider.captureOrder(plan.paypalOrderId, captureRequestId(plan.planId));
      const order = await this.provider.getOrder(plan.paypalOrderId);
      if (!isCaptureConfirmed(order, plan.paypalOrderId)) {
        return this.failPlan(plan, product, events, true, "PayPal did not confirm a completed capture.");
      }
      const captureConfirmedEvent = createEvent(
        "PAYPAL_CAPTURED",
        "PayPal confirmed the capture completed.",
        new Date().toISOString()
      );
      events.push(captureConfirmedEvent);
      this.plans.appendEvents(plan.planId, [captureConfirmedEvent]);
      const verification = verifyCapturedOrder(order, plan);
      if (verification instanceof Error) {
        return this.failPlan(plan, product, events, true, verification.message);
      }
      return this.completeVerifiedCapture(plan, product, verification.captureId, events);
    } catch (error) {
      if (error instanceof PaymentConfigurationError) throw error;
      try {
        const order = await this.provider.getOrder(plan.paypalOrderId);
        if (isCaptureConfirmed(order, plan.paypalOrderId)) {
          const captureConfirmedEvent = createEvent(
            "PAYPAL_CAPTURED",
            "PayPal confirmed the capture completed.",
            new Date().toISOString()
          );
          events.push(captureConfirmedEvent);
          this.plans.appendEvents(plan.planId, [captureConfirmedEvent]);
          const verification = verifyCapturedOrder(order, plan);
          if (verification instanceof Error) {
            return this.failPlan(plan, product, events, true, verification.message);
          }
          return this.completeVerifiedCapture(plan, product, verification.captureId, events);
        }
      } catch (statusError) {
        if (statusError instanceof PaymentConfigurationError) throw statusError;
      }
      const message = "PayPal did not provide a conclusive capture status. Refresh transaction status before taking further action.";
      const pendingEvent = createEvent("PAYMENT_STATUS_PENDING", message, new Date().toISOString());
      events.push(pendingEvent);
      this.plans.appendEvents(plan.planId, [pendingEvent]);
      return {
        plan,
        product,
        events,
        failure: { code: "PAYMENT_FAILED", message }
      };
    }
  }

  async getTransactionStatus(planId: string): Promise<{ plan: PurchasePlan; product: Product; events: AgentEvent[] } | undefined> {
    let plan = this.plans.get(planId);
    const product = plan ? this.products.get(plan.productId) : undefined;
    if (!plan || !product) return undefined;
    if (plan.status === "EXECUTING" && plan.paypalOrderId) {
      const order = await this.provider.getOrder(plan.paypalOrderId);
      if (isCaptureConfirmed(order, plan.paypalOrderId)) {
        const existingEvents = this.plans.getEvents(planId);
        if (!existingEvents.some((event) => event.type === "PAYPAL_BUYER_APPROVED")) {
          this.plans.appendEvents(planId, [
            createEvent("PAYPAL_BUYER_APPROVED", "PayPal order status confirms buyer approval.", new Date().toISOString())
          ]);
        }
        if (!existingEvents.some((event) => event.type === "PAYPAL_CAPTURED")) {
          this.plans.appendEvents(planId, [
            createEvent("PAYPAL_CAPTURED", "PayPal confirmed the capture completed.", new Date().toISOString())
          ]);
        }
        const verification = verifyCapturedOrder(order, plan);
        if (verification instanceof Error) {
          const events = [
            createEvent("PAYMENT_VERIFICATION_FAILED", verification.message, new Date().toISOString()),
            createEvent("PAYMENT_FAILED", verification.message, new Date().toISOString())
          ];
          plan = PurchasePlanSchema.parse({
            ...plan,
            status: "FAILED",
            paymentFailureReason: verification.message
          });
          this.plans.save(plan);
          this.plans.appendEvents(plan.planId, events);
        } else {
          const completed = this.completeVerifiedCapture(plan, product, verification.captureId, []);
          plan = completed.plan;
        }
      }
    }
    return { plan, product, events: this.plans.getEvents(planId) };
  }

  private completeVerifiedCapture(
    plan: PurchasePlan,
    product: Product,
    captureId: string,
    events: AgentEvent[]
  ): PaymentActionResult {
    const completedAt = new Date().toISOString();
    const completed = PurchasePlanSchema.parse({
      ...plan,
      status: "COMPLETED",
      paypalCaptureId: captureId,
      completedAt,
      paymentFailureReason: null
    });
    this.plans.save(completed);
    events.push(
      createEvent("PAYMENT_VERIFICATION_PASSED", "Server verification confirmed the PayPal order, capture status, currency, and amount.", new Date().toISOString()),
      createEvent("PURCHASE_COMPLETED", `${product.title} payment completed successfully.`, completedAt)
    );
    this.plans.appendEvents(plan.planId, events);
    return { plan: completed, product, events };
  }

  private failPlan(
    plan: PurchasePlan,
    product: Product,
    events: AgentEvent[],
    verificationFailed: boolean,
    reason: string
  ): PaymentActionResult {
    const failed = PurchasePlanSchema.parse({ ...plan, status: "FAILED", paymentFailureReason: reason });
    this.plans.save(failed);
    const createdAt = new Date().toISOString();
    if (verificationFailed) {
      events.push(createEvent("PAYMENT_VERIFICATION_FAILED", reason, createdAt));
    }
    events.push(createEvent("PAYMENT_FAILED", reason, createdAt));
    this.plans.appendEvents(plan.planId, events);
    return {
      plan: failed,
      product,
      events,
      failure: {
        code: verificationFailed ? "PAYMENT_VERIFICATION_FAILED" : "PAYMENT_FAILED",
        message: reason
      }
    };
  }

  private requirePlan(planId: string): PurchasePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new PaymentPlanNotFoundError();
    return plan;
  }

  private verifyAuthoritativePlan(plan: PurchasePlan) {
    const product = this.products.get(plan.productId);
    if (!product || !product.price || !product.merchant || product.availability !== "in_stock") {
      throw new PaymentPlanStateError();
    }
    try {
      assertCurrencyMatch(plan.currency, product.price.currency);
      const unitPriceMinor = parseMajorToMinor(product.price.amount, product.price.currency);
      const totalMinor = calculateTotalMinor(unitPriceMinor, plan.quantity);
      if (
        product.id !== plan.productId ||
        product.merchant !== plan.merchant ||
        unitPriceMinor !== plan.unitPriceMinor ||
        totalMinor !== plan.totalMinor ||
        plan.authoritativeTotal.currency !== plan.currency ||
        plan.authoritativeUnitPrice.currency !== plan.currency ||
        parseMajorToMinor(plan.authoritativeUnitPrice.amount, plan.currency) !== unitPriceMinor ||
        parseMajorToMinor(plan.authoritativeTotal.amount, plan.currency) !== totalMinor
      ) {
        throw new PaymentPlanStateError();
      }
    } catch (error) {
      if (error instanceof PaymentPlanStateError) throw error;
      if (error instanceof MoneyError) throw new PaymentPlanStateError();
      throw error;
    }
    return product;
  }
}

function verifyCapturedOrder(
  order: Awaited<ReturnType<PaymentProvider["getOrder"]>>,
  plan: PurchasePlan
): { captureId: string } | Error {
  if (order.id !== plan.paypalOrderId || order.status !== "COMPLETED") {
    return new Error("PayPal order status or ID did not match the expected completed transaction.");
  }
  const captures = order.purchaseUnits.flatMap((unit) => unit.captures);
  if (captures.length === 0 || captures.some((capture) => capture.status !== "COMPLETED")) {
    return new Error("PayPal did not confirm a completed capture.");
  }
  try {
    let capturedMinor = 0;
    for (const capture of captures) {
      assertCurrencyMatch(plan.currency, capture.currency);
      const amountMinor = parseMajorToMinor(capture.amount, capture.currency);
      capturedMinor += amountMinor;
      if (!Number.isSafeInteger(capturedMinor)) return new Error("Captured amount exceeds the supported verification range.");
    }
    if (capturedMinor !== plan.totalMinor) {
      return new Error("PayPal captured amount does not match the approved purchase total.");
    }
  } catch {
    return new Error("PayPal capture currency or amount could not be verified.");
  }
  return { captureId: captures[0]!.id };
}

function isCaptureConfirmed(order: Awaited<ReturnType<PaymentProvider["getOrder"]>>, expectedOrderId: string): boolean {
  const captures = order.purchaseUnits.flatMap((unit) => unit.captures);
  return order.id === expectedOrderId &&
    order.status === "COMPLETED" &&
    captures.length > 0 &&
    captures.every((capture) => capture.status === "COMPLETED");
}

function createEvent(type: AgentEvent["type"], message: string, createdAt: string): AgentEvent {
  return { id: randomUUID(), type, message, createdAt };
}

function captureRequestId(planId: string): string {
  return createHash("sha256").update(`paypal-capture:${planId}`).digest("hex").slice(0, 36);
}
