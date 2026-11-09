import type { AgentEvent, PurchasePlan } from "./index.js";

export type TransactionReceiptState = "success" | "cancelled" | "failed" | "pending" | "hidden";

export const MERCHANT_FULFILLMENT_DISCLOSURE =
  "Payment confirmed through PayPal Sandbox. RELAY has not submitted an order to the external retailer or confirmed shipping or fulfillment.";

export function getTransactionReceiptState(
  plan: PurchasePlan,
  events: AgentEvent[],
  options: { serverConfirmed: boolean; checkoutCancelled: boolean }
): TransactionReceiptState {
  if (!options.serverConfirmed) {
    return ["EXECUTING", "COMPLETED", "FAILED"].includes(plan.status) ? "pending" : "hidden";
  }
  if (plan.status === "COMPLETED" &&
    events.some((event) => event.type === "PAYPAL_BUYER_APPROVED") &&
    events.some((event) => event.type === "PAYPAL_CAPTURED") &&
    events.some((event) => event.type === "PAYMENT_VERIFICATION_PASSED") &&
    events.some((event) => event.type === "PURCHASE_COMPLETED")) {
    return "success";
  }
  if (plan.status === "COMPLETED") return "pending";
  if (plan.status === "FAILED") return "failed";
  if (options.checkoutCancelled) return "cancelled";
  if (plan.status === "EXECUTING") return "pending";
  return "hidden";
}

export function getReceiptVerificationChecks(
  plan: PurchasePlan,
  events: AgentEvent[],
  serverConfirmed: boolean
): Array<{ label: string; passed: boolean }> {
  const completed = serverConfirmed && plan.status === "COMPLETED";
  const hasEvent = (type: AgentEvent["type"]) => events.some((event) => event.type === type);
  const verified = completed && hasEvent("PAYMENT_VERIFICATION_PASSED");
  return [
    { label: "Buyer approval received", passed: completed && hasEvent("PAYPAL_BUYER_APPROVED") },
    { label: "PayPal capture completed", passed: completed && hasEvent("PAYPAL_CAPTURED") },
    { label: "Order ID verified", passed: verified },
    { label: "Amount verified", passed: verified },
    { label: "Currency verified", passed: verified },
    { label: "RELAY transaction completed", passed: completed && hasEvent("PURCHASE_COMPLETED") }
  ];
}
