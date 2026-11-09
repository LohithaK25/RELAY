import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  PurchasePlanSchema,
  type AgentEvent,
  type Policy,
  type Product,
  type PurchasePlan
} from "@relay/shared";
import type { ProductRepository } from "../commerce/product-repository.js";
import { evaluatePolicy } from "./policy-engine.js";
import { assertCurrencyMatch, minorToMajor, parseMajorToMinor, calculateTotalMinor, MoneyError } from "./money.js";
import type { PolicyConfiguration } from "./policy-types.js";
import { resolveEffectivePolicy } from "./validation.js";

export class ProductNotVerifiedError extends Error {
  constructor() {
    super("The selected product is not available in RELAY's verified product context.");
    this.name = "ProductNotVerifiedError";
  }
}

export class PlanNotApprovableError extends Error {
  constructor() {
    super("This purchase plan is not awaiting user approval.");
    this.name = "PlanNotApprovableError";
  }
}

export class PurchaseQuantityMismatchError extends Error {
  constructor() {
    super("Purchase quantity must match the quantity in the verified shopping intent.");
    this.name = "PurchaseQuantityMismatchError";
  }
}

export class PlanRepository {
  private readonly plans = new Map<string, PurchasePlan>();
  private readonly events = new Map<string, AgentEvent[]>();

  save(plan: PurchasePlan): void {
    const validated = PurchasePlanSchema.parse(plan);
    this.plans.set(validated.planId, validated);
  }

  get(planId: string): PurchasePlan | undefined {
    const plan = this.plans.get(planId);
    return plan ? PurchasePlanSchema.parse(plan) : undefined;
  }

  appendEvents(planId: string, events: AgentEvent[]): void {
    const stored = this.events.get(planId) ?? [];
    const knownIds = new Set(stored.map((event) => event.id));
    const appended = events
      .map((event) => AgentEventSchema.parse(event))
      .filter((event) => !knownIds.has(event.id));
    this.events.set(planId, [...stored, ...appended]);
  }

  getEvents(planId: string): AgentEvent[] {
    return (this.events.get(planId) ?? []).map((event) => AgentEventSchema.parse(event));
  }

  clear(): void {
    this.plans.clear();
    this.events.clear();
  }
}

export interface CreatedPurchasePlan {
  plan: PurchasePlan;
  product: Product;
  events: AgentEvent[];
}

export class PurchasePlanService {
  constructor(
    private readonly products: ProductRepository,
    private readonly plans: PlanRepository,
    private readonly policyConfiguration: PolicyConfiguration
  ) {}

  get productRepositoryInstanceId(): string {
    return this.products.instanceId;
  }

  create(input: {
    productId: string;
    quantity: number;
    policy: Partial<Policy>;
  }): CreatedPurchasePlan {
    const product = this.products.get(input.productId);
    const intent = this.products.getIntent(input.productId);
    if (!product || !intent || !product.price || !product.merchant) throw new ProductNotVerifiedError();
    if (input.quantity !== intent.quantity) throw new PurchaseQuantityMismatchError();

    const serverPolicy = this.policyConfiguration.defaultPolicy;
    const policy = resolveEffectivePolicy(serverPolicy, input.policy);
    let unitPriceMinor: number;
    let totalMinor: number;
    try {
      assertCurrencyMatch(serverPolicy.currency, product.price.currency);
      unitPriceMinor = parseMajorToMinor(product.price.amount, product.price.currency);
      totalMinor = calculateTotalMinor(unitPriceMinor, input.quantity);
    } catch (error) {
      if (error instanceof MoneyError) throw new ProductNotVerifiedError();
      throw error;
    }

    const policyCheckStartedAt = new Date().toISOString();
    const evaluation = evaluatePolicy({
      intent,
      product,
      quantity: input.quantity,
      policy
    }, policyCheckStartedAt);
    if (evaluation.unitPriceMinor === null || evaluation.totalMinor === null) throw new ProductNotVerifiedError();

    const createdAt = new Date().toISOString();
    const plan = PurchasePlanSchema.parse({
      planId: randomUUID(),
      productId: product.id,
      merchant: product.merchant,
      quantity: input.quantity,
      currency: product.price.currency,
      authoritativeUnitPrice: {
        amount: minorToMajor(unitPriceMinor, product.price.currency),
        currency: product.price.currency
      },
      authoritativeTotal: {
        amount: minorToMajor(totalMinor, product.price.currency),
        currency: product.price.currency
      },
      unitPriceMinor,
      totalMinor,
      policyDecision: evaluation.decision,
      createdAt,
      status: evaluation.decision.allowed ? "AWAITING_APPROVAL" : "POLICY_REJECTED"
    });
    this.plans.save(plan);

    const events: AgentEvent[] = [
      createEvent("POLICY_CHECK_STARTED", "Deterministic policy checks started.", policyCheckStartedAt),
      createEvent(
        evaluation.decision.allowed ? "POLICY_CHECK_PASSED" : "POLICY_CHECK_FAILED",
        evaluation.decision.allowed
          ? "All mandatory policy checks passed."
          : `${evaluation.decision.checks.filter((item) => !item.passed).length} mandatory policy check(s) failed.`,
        new Date().toISOString()
      )
    ];
    if (plan.status === "POLICY_REJECTED") {
      const failedChecks = evaluation.decision.checks.filter((item) => !item.passed);
      const quantityFailure = failedChecks.find((item) => item.name === "QUANTITY_LIMIT");
      events.push(createEvent(
        "PURCHASE_BLOCKED",
        quantityFailure
          ? `Execution prevented because ${quantityFailure.message.charAt(0).toLocaleLowerCase()}${quantityFailure.message.slice(1)}`
          : `Execution prevented because ${failedChecks.map((item) => item.message).join(" ")}`,
        new Date().toISOString()
      ));
    } else {
      events.push(
        createEvent("PURCHASE_PLAN_CREATED", "Purchase plan created from RELAY's verified product record.", createdAt),
        createEvent("PURCHASE_PLAN_READY", "Verified purchase plan passed policy evaluation and is ready for human review.", new Date().toISOString()),
        createEvent("AWAITING_APPROVAL", "Plan is waiting for explicit user approval.", new Date().toISOString()),
        createEvent("USER_APPROVAL_REQUIRED", "No payment has been initiated.", new Date().toISOString())
      );
    }
    this.plans.appendEvents(plan.planId, events);
    return { plan, product, events };
  }

  approve(planId: string): CreatedPurchasePlan {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== "AWAITING_APPROVAL" || !plan.policyDecision.allowed) {
      throw new PlanNotApprovableError();
    }
    const product = this.products.get(plan.productId);
    if (!product) throw new ProductNotVerifiedError();
    if (!product.price || !product.merchant || product.availability !== "in_stock") throw new ProductNotVerifiedError();
    try {
      assertCurrencyMatch(plan.currency, product.price.currency);
      if (
        parseMajorToMinor(product.price.amount, product.price.currency) !== plan.unitPriceMinor ||
        product.merchant !== plan.merchant
      ) {
        throw new ProductNotVerifiedError();
      }
    } catch (error) {
      if (error instanceof ProductNotVerifiedError) throw error;
      if (error instanceof MoneyError) throw new ProductNotVerifiedError();
      throw error;
    }

    const approvedPlan = PurchasePlanSchema.parse({ ...plan, status: "APPROVED" });
    this.plans.save(approvedPlan);
    const createdAt = new Date().toISOString();
    const events = [createEvent("USER_APPROVED", "Approved by you. Payment execution is ready.", createdAt)];
    this.plans.appendEvents(plan.planId, events);
    return {
      plan: approvedPlan,
      product,
      events
    };
  }
}

function createEvent(type: AgentEvent["type"], message: string, createdAt: string): AgentEvent {
  return { id: randomUUID(), type, message, createdAt };
}
