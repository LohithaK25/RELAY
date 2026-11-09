import type { AgentEvent } from "./index.js";

export type AuditEventSource =
  | "REQUEST"
  | "AI INTERPRETATION"
  | "DETERMINISTIC SOFTWARE"
  | "HUMAN AUTHORIZATION"
  | "PAYPAL"
  | "SERVER VERIFICATION";

export type AuditEventState = "complete" | "pending" | "rejected" | "failed" | "cancelled";

export interface AuditEventPresentation {
  source: AuditEventSource;
  state: AuditEventState;
}

export function getAuditEventPresentation(type: AgentEvent["type"]): AuditEventPresentation {
  switch (type) {
    case "REQUEST_RECEIVED":
      return { source: "REQUEST", state: "complete" };
    case "INTENT_PARSED":
      return { source: "AI INTERPRETATION", state: "complete" };
    case "PRODUCTS_DISCOVERED":
      return { source: "DETERMINISTIC SOFTWARE", state: "complete" };
    case "PRODUCTS_FILTERED":
    case "PRODUCTS_RANKED":
    case "POLICY_CHECK":
    case "POLICY_CHECK_STARTED":
    case "POLICY_CHECK_PASSED":
    case "PURCHASE_PLAN_READY":
    case "PURCHASE_PLAN_CREATED":
      return { source: "DETERMINISTIC SOFTWARE", state: "complete" };
    case "POLICY_CHECK_FAILED":
      return { source: "DETERMINISTIC SOFTWARE", state: "rejected" };
    case "PURCHASE_BLOCKED":
      return { source: "DETERMINISTIC SOFTWARE", state: "rejected" };
    case "AWAITING_APPROVAL":
    case "USER_APPROVAL_REQUIRED":
      return { source: "HUMAN AUTHORIZATION", state: "pending" };
    case "USER_APPROVED":
      return { source: "HUMAN AUTHORIZATION", state: "complete" };
    case "PAYMENT_CREATED":
    case "PAYMENT_UPDATED":
    case "PAYPAL_ORDER_CREATED":
    case "PAYPAL_BUYER_APPROVED":
    case "PAYPAL_CAPTURED":
      return { source: "PAYPAL", state: "complete" };
    case "PAYPAL_ORDER_FAILED":
      return { source: "PAYPAL", state: "failed" };
    case "PAYPAL_CHECKOUT_CANCELLED":
      return { source: "PAYPAL", state: "cancelled" };
    case "PAYPAL_APPROVAL_REQUIRED":
    case "PAYPAL_CAPTURE_STARTED":
    case "PAYMENT_STATUS_PENDING":
      return { source: "PAYPAL", state: "pending" };
    case "PAYMENT_VERIFICATION_PASSED":
    case "PURCHASE_COMPLETED":
      return { source: "SERVER VERIFICATION", state: "complete" };
    case "PAYMENT_VERIFICATION_FAILED":
    case "PAYMENT_FAILED":
      return { source: "SERVER VERIFICATION", state: "failed" };
  }
}
