import { z } from "zod";

export const ShoppingIntentSchema = z.object({
  originalRequest: z.string().min(1),
  category: z.string().nullable(),
  productType: z.string().nullable(),
  budget: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3)
  }).nullable(),
  requiredAttributes: z.array(z.string()),
  preferredAttributes: z.array(z.string()),
  excludedAttributes: z.array(z.string()),
  deliveryRequirement: z.string().nullable(),
  quantity: z.number().int().positive(),
  location: z.string().nullable(),
  country: z.string().length(2).nullable(),
  additionalPreferences: z.array(z.string())
}).strict();

export const ProductSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  imageUrl: z.string().url().nullable(),
  productUrl: z.string().url().nullable(),
  merchant: z.string().min(1).nullable(),
  price: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().length(3)
  }).nullable(),
  availability: z.enum(["in_stock", "out_of_stock", "unknown"]),
  category: z.string().nullable(),
  attributes: z.record(z.string()),
  source: z.literal("channel3")
}).strict();

export const ProductCandidateSchema = z.object({
  product: ProductSchema,
  score: z.number().min(0).max(1),
  reasoning: z.string()
});

export const PolicySchema = z.object({
  maxTransactionAmount: z.number().positive(),
  currency: z.string().length(3),
  maxItemPrice: z.number().positive(),
  maxQuantity: z.number().int().positive(),
  allowedCategories: z.array(z.string()).default([]),
  blockedCategories: z.array(z.string()).default([]),
  allowedMerchants: z.array(z.string()).default([]),
  blockedMerchants: z.array(z.string()).default([]),
  requireApproval: z.boolean().default(true),
  autoApproveBelow: z.number().nonnegative().default(0)
}).strict();

export const PurchasePlanSchema = z.object({
  planId: z.string().uuid(),
  productId: z.string().min(1),
  merchant: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  currency: z.string().length(3),
  authoritativeUnitPrice: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3) }),
  authoritativeTotal: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3) }),
  unitPriceMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  policyDecision: z.lazy(() => PolicyDecisionSchema),
  createdAt: z.string().datetime(),
  status: z.enum(["DRAFT", "POLICY_REJECTED", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "COMPLETED", "FAILED"]),
  paypalOrderId: z.string().min(1).nullable().default(null),
  paypalCaptureId: z.string().min(1).nullable().default(null),
  paypalApprovalUrl: z.string().url().nullable().default(null),
  completedAt: z.string().datetime().nullable().default(null),
  paymentFailureReason: z.string().nullable().default(null)
});

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  checks: z.array(z.object({
    name: z.enum([
      "PRODUCT_VERIFIED",
      "TRANSACTION_LIMIT",
      "ITEM_PRICE_LIMIT",
      "QUANTITY_LIMIT",
      "CATEGORY_ALLOWLIST",
      "CATEGORY_BLOCKLIST",
      "MERCHANT_ALLOWLIST",
      "MERCHANT_BLOCKLIST",
      "APPROVAL_REQUIRED"
    ]),
    passed: z.boolean(),
    message: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional()
  })),
  evaluatedAt: z.string().datetime()
});

export const PaymentSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["created", "pending", "completed", "failed", "cancelled"]),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  providerReference: z.string().optional()
});

export const AgentEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "REQUEST_RECEIVED",
    "INTENT_PARSED",
    "PRODUCTS_DISCOVERED",
    "PRODUCTS_FILTERED",
    "PRODUCTS_RANKED",
    "POLICY_CHECK",
    "POLICY_CHECK_STARTED",
    "POLICY_CHECK_PASSED",
    "POLICY_CHECK_FAILED",
    "PURCHASE_PLAN_READY",
    "PURCHASE_PLAN_CREATED",
    "PURCHASE_BLOCKED",
    "AWAITING_APPROVAL",
    "USER_APPROVAL_REQUIRED",
    "USER_APPROVED",
    "PAYMENT_CREATED",
    "PAYMENT_UPDATED",
    "PAYPAL_ORDER_CREATED",
    "PAYPAL_ORDER_FAILED",
    "PAYPAL_APPROVAL_REQUIRED",
    "PAYPAL_BUYER_APPROVED",
    "PAYPAL_CHECKOUT_CANCELLED",
    "PAYPAL_CAPTURE_STARTED",
    "PAYPAL_CAPTURED",
    "PAYMENT_STATUS_PENDING",
    "PAYMENT_VERIFICATION_PASSED",
    "PAYMENT_VERIFICATION_FAILED",
    "PAYMENT_FAILED",
    "PURCHASE_COMPLETED"
  ]),
  message: z.string(),
  createdAt: z.string().datetime()
});

export const TransactionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["draft", "awaiting_approval", "approved", "paid", "failed", "cancelled"]),
  product: ProductSchema,
  plan: PurchasePlanSchema,
  payment: PaymentSchema.optional(),
  events: z.array(AgentEventSchema).default([])
});

export type ShoppingIntent = z.infer<typeof ShoppingIntentSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export type PurchasePlan = z.infer<typeof PurchasePlanSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export { getAuditEventPresentation } from "./audit-timeline.js";
export type { AuditEventPresentation, AuditEventSource, AuditEventState } from "./audit-timeline.js";
export {
  getReceiptVerificationChecks,
  getTransactionReceiptState,
  MERCHANT_FULFILLMENT_DISCLOSURE
} from "./transaction-receipt.js";
export type { TransactionReceiptState } from "./transaction-receipt.js";
