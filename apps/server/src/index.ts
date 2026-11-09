import express, { type ErrorRequestHandler } from "express";
import { createGeminiAIProvider } from "./ai/gemini/provider.js";
import type { AIProvider } from "./ai/provider.js";
import { createAgentRouter } from "./routes/agent.js";
import { createChannel3CommerceProvider } from "./commerce/channel3/provider.js";
import type { CommerceProvider } from "./commerce/provider.js";
import { ProductRepository } from "./commerce/product-repository.js";
import { PlanRepository } from "./trust/purchase-plan.js";
import { loadPolicyConfiguration } from "./trust/validation.js";
import type { PolicyConfiguration } from "./trust/policy-types.js";
import { createPayPalPaymentProvider } from "./payment/paypal/client.js";
import type { PaymentProvider } from "./payment/provider.js";

export function createApp(
  provider: AIProvider = createGeminiAIProvider(),
  commerceProvider: CommerceProvider = createChannel3CommerceProvider(),
  products = new ProductRepository(),
  plans = new PlanRepository(),
  policyConfiguration: PolicyConfiguration = loadPolicyConfiguration(),
  paymentProvider: PaymentProvider = createPayPalPaymentProvider()
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "relay-api",
      timestamp: new Date().toISOString()
    });
  });

  app.use("/api/agent", createAgentRouter(provider, commerceProvider, products, plans, policyConfiguration, paymentProvider));

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON." }
      });
      return;
    }
    if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
      response.status(413).json({
        success: false,
        error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the allowed size." }
      });
      return;
    }
    response.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "RELAY could not process this request. Please try again." }
    });
  };
  app.use(errorHandler);

  return app;
}
