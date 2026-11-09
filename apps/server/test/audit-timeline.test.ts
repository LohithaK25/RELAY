import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAuditEventPresentation,
  getReceiptVerificationChecks,
  getTransactionReceiptState,
  MERCHANT_FULFILLMENT_DISCLOSURE,
  PurchasePlanSchema,
  type AgentEvent
} from "@relay/shared";

describe("transaction audit event presentation", () => {
  it("distinguishes AI interpretation from deterministic policy decisions", () => {
    assert.deepEqual(getAuditEventPresentation("INTENT_PARSED"), {
      source: "AI INTERPRETATION",
      state: "complete"
    });
    assert.deepEqual(getAuditEventPresentation("POLICY_CHECK_PASSED"), {
      source: "DETERMINISTIC SOFTWARE",
      state: "complete"
    });
    assert.deepEqual(getAuditEventPresentation("POLICY_CHECK_FAILED"), {
      source: "DETERMINISTIC SOFTWARE",
      state: "rejected"
    });
    assert.deepEqual(getAuditEventPresentation("PURCHASE_BLOCKED"), {
      source: "DETERMINISTIC SOFTWARE",
      state: "rejected"
    });
  });

  it("marks approval waits, PayPal capture, and verification outcomes accurately", () => {
    assert.equal(getAuditEventPresentation("AWAITING_APPROVAL").state, "pending");
    assert.equal(getAuditEventPresentation("PAYPAL_CAPTURE_STARTED").state, "pending");
    assert.equal(getAuditEventPresentation("PAYMENT_STATUS_PENDING").state, "pending");
    assert.equal(getAuditEventPresentation("PAYPAL_ORDER_FAILED").state, "failed");
    assert.equal(getAuditEventPresentation("PAYPAL_BUYER_APPROVED").source, "PAYPAL");
    assert.equal(getAuditEventPresentation("PAYMENT_VERIFICATION_PASSED").source, "SERVER VERIFICATION");
    assert.equal(getAuditEventPresentation("PAYMENT_VERIFICATION_PASSED").state, "complete");
    assert.equal(getAuditEventPresentation("PAYMENT_VERIFICATION_FAILED").state, "failed");
    assert.equal(getAuditEventPresentation("PAYPAL_CHECKOUT_CANCELLED").state, "cancelled");
  });

  it("shows a success receipt only for server-confirmed, verified completion", () => {
    const plan = receiptPlan("COMPLETED");
    const events = receiptEvents();
    assert.equal(getTransactionReceiptState(plan, events, {
      serverConfirmed: true,
      checkoutCancelled: false
    }), "success");
    assert.deepEqual(getReceiptVerificationChecks(plan, events, true).map((check) => check.passed), [
      true, true, true, true, true, true
    ]);
  });

  it("does not show success for plans awaiting approval, approved, executing, or failed", () => {
    const events = receiptEvents();
    for (const status of ["AWAITING_APPROVAL", "APPROVED", "EXECUTING", "FAILED"] as const) {
      assert.notEqual(getTransactionReceiptState(receiptPlan(status), events, {
        serverConfirmed: true,
        checkoutCancelled: false
      }), "success");
    }
    assert.equal(getTransactionReceiptState(receiptPlan("COMPLETED"), events, {
      serverConfirmed: false,
      checkoutCancelled: false
    }), "pending");
    assert.equal(getTransactionReceiptState(receiptPlan("FAILED"), events, {
      serverConfirmed: true,
      checkoutCancelled: false
    }), "failed");
    assert.equal(getTransactionReceiptState(receiptPlan("COMPLETED"), events.filter((event) => event.type !== "PAYPAL_CAPTURED"), {
      serverConfirmed: true,
      checkoutCancelled: false
    }), "pending");
  });

  it("presents a cancelled checkout as not completed and discloses fulfillment limits", () => {
    assert.equal(getTransactionReceiptState(receiptPlan("EXECUTING"), [], {
      serverConfirmed: true,
      checkoutCancelled: true
    }), "cancelled");
    assert.match(MERCHANT_FULFILLMENT_DISCLOSURE, /has not submitted an order to the external retailer/);
    assert.match(MERCHANT_FULFILLMENT_DISCLOSURE, /confirmed shipping or fulfillment/);
  });
});

function receiptPlan(status: "COMPLETED" | "AWAITING_APPROVAL" | "APPROVED" | "EXECUTING" | "FAILED") {
  return PurchasePlanSchema.parse({
    planId: "a0b1c2d3-e4f5-4678-9012-abcdefabcdef",
    productId: "channel3-product",
    merchant: "merchant.example",
    quantity: 1,
    currency: "USD",
    authoritativeUnitPrice: { amount: 99.99, currency: "USD" },
    authoritativeTotal: { amount: 99.99, currency: "USD" },
    unitPriceMinor: 9999,
    totalMinor: 9999,
    policyDecision: { allowed: true, requiresApproval: true, checks: [], evaluatedAt: "2026-01-01T00:00:00.000Z" },
    createdAt: "2026-01-01T00:00:00.000Z",
    status,
    paypalOrderId: "ORDER-123",
    paypalCaptureId: "CAPTURE-123",
    completedAt: status === "COMPLETED" ? "2026-01-01T00:01:00.000Z" : null
  });
}

function receiptEvents(): AgentEvent[] {
  const types: AgentEvent["type"][] = [
    "PAYPAL_BUYER_APPROVED",
    "PAYPAL_CAPTURED",
    "PAYMENT_VERIFICATION_PASSED",
    "PURCHASE_COMPLETED"
  ];
  return types.map((type, index) => ({
    id: `event-${index}`,
    type,
    message: "Server-recorded test event.",
    createdAt: "2026-01-01T00:01:00.000Z"
  }));
}
