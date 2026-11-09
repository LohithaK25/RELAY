# RELAY architecture

This document describes behavior implemented in the repository. It distinguishes model-assisted interpretation from server-authoritative decisions and payment actions.

## Implemented lifecycle

```text
USER REQUEST
  → GEMINI INTENT
  → CHANNEL3 DISCOVERY
  → DETERMINISTIC FILTERING AND RANKING
  → TRUST / POLICY ENGINE
  → HUMAN APPROVAL
  → PAYPAL CHECKOUT
  → SERVER CAPTURE AND VERIFICATION
  → COMPLETED TRANSACTION
```

1. **User request and intent:** The browser sends the natural-language request to the Express API. The Gemini provider returns structured data validated as a shared `ShoppingIntent`. Gemini's interpretation is descriptive input, not a price quote or payment instruction.
2. **Product discovery:** The server sends a deterministic query to the Channel3 provider, validates and normalizes returned candidates, then applies deterministic availability, currency, total-budget, required/excluded-attribute filters and ranking. Product candidates and the originating intent are retained in a process-local repository.
3. **Purchase plan:** The browser can request a plan only for a product in that verified search context. The request quantity must match the verified intent quantity. The server reads price, currency, and merchant from the repository, calculates the total in integer minor units, and evaluates policy. It never trusts a client amount or currency.
4. **Trust decision:** The policy engine checks product availability, transaction total, item price, maximum quantity, category and merchant rules. A failed check creates a `POLICY_REJECTED` plan; it is not approvable or executable. A passing plan remains `AWAITING_APPROVAL`, and explicit human approval changes it to `APPROVED`. Approval cannot be disabled by client policy.
5. **PayPal checkout:** Only an `APPROVED` plan can create a PayPal Sandbox order. The server constructs the amount and currency from the authoritative plan. The buyer approves on PayPal and returns to RELAY.
6. **Capture and verification:** The server requests capture and retrieves the order. It verifies the returned order ID, order and capture completion state, capture currency, and aggregate captured amount against the approved plan. Only verified completion changes the plan to `COMPLETED`; the verified capture ID and server completion timestamp are retained on the plan when supplied.
7. **Audit presentation:** Server-originated lifecycle events and concise explanations are shown in the transaction timeline. It distinguishes Gemini-derived intent, deterministic policy decisions, user authorization, and PayPal states. It does not expose or claim to reveal hidden chain-of-thought.
8. **Payment receipt:** The browser displays a receipt only after the capture response or read-only transaction-status endpoint confirms a completed plan and the required verification events. The receipt uses server-returned plan and product facts; browser session storage is presentation context only. A PayPal checkout cancellation remains distinct from a completed payment.

## Trust boundaries

- **Gemini is not authoritative** for price, currency, merchant, product availability, policy, or final total.
- **Channel3 product data is external input.** It is schema-validated and normalized; final plan creation and payment re-check the server-held product facts.
- **The browser is untrusted.** Client-submitted amount, currency, merchant, policy relaxations, and a quantity inconsistent with the verified intent cannot override server state.
- **The policy engine is deterministic.** The server-configured maximum quantity defaults to one. An intent requesting more is preserved in the plan and rejected by policy rather than silently altered.
- **Human approval is a hard boundary.** Only an eligible plan in the approved state can proceed to PayPal order creation.
- **PayPal credentials are server-only.** Sandbox order creation and capture use backend environment configuration; the browser receives only the approval URL and non-secret transaction data.

## Implemented versus future work

**Implemented:** Gemini intent extraction, Channel3 discovery provider, deterministic filtering/ranking, server-side purchase plans and policy checks, mandatory explicit approval, PayPal Sandbox order/capture integration, server-side capture verification, a session-visible audit timeline, and a post-payment confirmation for server-verified completed plans. A read-only transaction status endpoint supports page-reload recovery without triggering capture.

**Not implemented:** Retailer order submission or fulfillment, database persistence, authentication, webhooks, durable audit storage, production PayPal support, or production deployment. A completed PayPal payment is not evidence that a retailer accepted an order or shipped a product. In-memory server state resets on restart; browser session storage retains only checkout presentation context across the PayPal redirect. There is no PostgreSQL/Prisma-backed data path in the current application.
