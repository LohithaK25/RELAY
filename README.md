# RELAY

**The trust layer for agentic commerce.**  
“Trust the agent. Control the transaction.”

RELAY is a hackathon prototype for agent-assisted shopping with explicit controls around money. It addresses a core risk of agentic commerce: an AI can help interpret a request and find options, but it must not determine or execute the payable amount.

> **AI proposes. Software decides. Humans authorize. PayPal transacts.**

## How it works

```text
USER REQUEST
  → GEMINI INTENT
  → CHANNEL3 DISCOVERY
  → DETERMINISTIC FILTERING AND RANKING
  → TRUST / POLICY ENGINE
  → HUMAN APPROVAL
  → PAYPAL SANDBOX CHECKOUT
  → SERVER CAPTURE AND VERIFICATION
  → COMPLETED TRANSACTION
```

Gemini converts the natural-language request into a Zod-validated `ShoppingIntent`; it does not set a payable price. Channel3 supplies product candidates, which RELAY normalizes and filters using deterministic availability, currency, budget, and attribute checks. The budget is a maximum total: the server compares the authoritative unit price multiplied by the requested quantity using integer currency minor units.

The server stores the verified product and intent context for the current process. The Trust / Policy Engine calculates the total from that server-side product, applies transaction, item-price, quantity, category, merchant, and approval rules, and creates either an approval-ready or rejected plan. A request quantity that differs from the verified intent is rejected; a quantity over the configured maximum is retained and rejected, never silently reduced.

Only a policy-eligible plan explicitly approved by the user can create a PayPal Sandbox order. After the buyer returns from PayPal, RELAY captures the order server-side and checks the order ID, completion status, captured currency, and total against the approved plan before marking the transaction complete. A post-payment receipt appears only after server-confirmed completion. `GET /api/agent/purchase-plan/:planId/status` supports read-only status refresh and reload recovery without automatically capturing again. RELAY confirms payment only; it does not submit an order to the external retailer or verify shipping/fulfillment. The audit timeline shows system events and concise decision reasons, not hidden model reasoning.

## Security and trust boundaries

- Product identity, price, merchant, availability, and currency come from RELAY's server-held verified discovery context; browser-supplied payment values cannot override them.
- The purchase quantity must match the verified shopping intent. The server applies its configured quantity ceiling and records over-limit plans as rejected; rejected plans cannot be approved or create PayPal orders.
- The Trust / Policy Engine evaluates totals using integer currency minor units and deterministic transaction, item-price, quantity, category, merchant, and approval rules.
- Human approval is required before order creation. Only approved plans can initiate PayPal Sandbox checkout.
- Capture is protected against duplicate requests and is followed by server-side order-ID, capture-status, currency, and amount verification. RELAY reports completion only after verification succeeds.
- Gemini interprets the request and may explain recommendations; deterministic server code decides policy and payable totals.
- Gemini and Channel3 keys, PayPal client credentials, and OAuth tokens are backend-only. Keep `.env` out of source control.

## Integrations

- **Gemini:** Google's `@google/genai` SDK produces structured shopping intent. The model is selected by `GEMINI_MODEL` (default: `gemini-3.6-flash`). Transient upstream failures are retried with a bounded policy.
- **Channel3:** The official `@channel3/sdk` is isolated behind a commerce provider interface. RELAY constructs the search query and performs its own deterministic filtering and ranking.
- **PayPal:** The server uses PayPal Sandbox REST credentials only. The client secret and OAuth tokens are not sent to the browser. No currency conversion is performed by RELAY.
- **Policy:** Defaults and optional stricter category/merchant rules are server-configured. Approval remains mandatory.

## Requirements

- Node.js 20+
- npm 10+

## Local setup

Install dependencies, create the root environment file, and configure provider credentials on the server:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Alternatively, copy `.env.example` to `.env` using your operating system's file-copy command. Set `GEMINI_API_KEY`, `CHANNEL3_API_KEY`, and PayPal **Sandbox** `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `.env` as needed. Keep this file local; never put credentials in frontend variables or source control. Without a provider key, the shell and health endpoint remain available, while the related API returns a clean configuration error.

The web app is served at [http://localhost:5173](http://localhost:5173); the Express API runs at [http://localhost:3001](http://localhost:3001). The web shell's status indicator calls `GET /api/health`.

### Environment variables

See [.env.example](./.env.example) for the complete list. In brief:

- `GEMINI_API_KEY`, `GEMINI_MODEL` — backend Gemini configuration.
- `CHANNEL3_API_KEY`, optional `CHANNEL3_BASE_URL`, `CHANNEL3_TIMEOUT_MS` — backend product discovery.
- `RELAY_POLICY_*` — server-enforced currency, amount, quantity, category, and merchant limits.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optional `PAYPAL_BASE_URL`, `PAYPAL_TIMEOUT_MS` — PayPal Sandbox configuration.
- `PORT`, `WEB_ORIGIN` — local server and browser origin.

`PAYPAL_BASE_URL` defaults to the Sandbox API. RELAY does not use a database; its product, purchase-plan, payment, and transaction event state is in memory and resets when the server restarts.

## Workspace

- `apps/web` — React, TypeScript, Vite, Tailwind CSS, Framer Motion, and Lucide.
- `apps/server` — Node.js, TypeScript, Express API, Gemini and Channel3 provider integrations, deterministic trust and payment services.
- `packages/shared` — shared Zod schemas and inferred TypeScript types used by the web and server workspaces.
- [docs/architecture.md](./docs/architecture.md) — implemented data flow, trust boundaries, and current limitations.

## Validation commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Current limitations

- This is a prototype, not a production commerce or payment system.
- Product and plan state is process-local, not durable; a server restart clears it. The audit history retained across PayPal return is browser-session storage.
- Authentication, durable audit storage, webhooks, production payment credentials, and production deployment are not implemented.
- Channel3 requires compatible provider credentials and returns product data that is subject to RELAY's own validation.
- PayPal flows use Sandbox only. A passing automated test does not constitute a live payment retest.
