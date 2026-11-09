import { randomUUID } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { ShoppingIntentSchema, type AgentEvent } from "@relay/shared";
import { z } from "zod";
import {
  AIConfigurationError,
  AIProviderError,
  InvalidAIOutputError
} from "../ai/provider.js";
import { IntentRequestError, ShoppingIntentService } from "../ai/intent-service.js";
import type { AIProvider } from "../ai/provider.js";
import {
  CommerceConfigurationError,
  CommerceProviderError,
  CommerceTimeoutError,
  InvalidCommerceResponseError
} from "../commerce/provider.js";
import type { CommerceProvider } from "../commerce/provider.js";
import { candidatesToProducts, ProductDiscoveryService } from "../commerce/search.js";
import { ProductRepository } from "../commerce/product-repository.js";
import {
  PlanRepository,
  ProductNotVerifiedError,
  PlanNotApprovableError,
  PurchasePlanService,
  PurchaseQuantityMismatchError
} from "../trust/purchase-plan.js";
import { ApprovePurchasePlanRequestSchema, InvalidUserPolicyError, PurchasePlanRequestSchema, loadPolicyConfiguration } from "../trust/validation.js";
import type { PolicyConfiguration } from "../trust/policy-types.js";
import {
  PaymentOrderMismatchError,
  PaymentPlanNotFoundError,
  PaymentPlanStateError,
  PaymentExecutionService
} from "../payment/payment-service.js";
import {
  InvalidPaymentResponseError,
  PaymentConfigurationError,
  PaymentProviderError,
  PaymentTimeoutError
} from "../payment/provider.js";
import type { PaymentProvider } from "../payment/provider.js";
import { createPayPalPaymentProvider } from "../payment/paypal/client.js";

const intentRequestSchema = z.object({
  request: z.string()
}).strict();

export function createAgentRouter(
  provider: AIProvider,
  commerceProvider: CommerceProvider,
  products: ProductRepository,
  plans = new PlanRepository(),
  policyConfiguration: PolicyConfiguration = loadPolicyConfiguration(),
  paymentProvider: PaymentProvider = createPayPalPaymentProvider()
): Router {
  const router = Router();
  router.post("/intent", createAgentIntentHandler(provider));
  router.post("/products", createAgentProductsHandler(commerceProvider, products));
  const purchasePlanService = new PurchasePlanService(products, plans, policyConfiguration);
  router.post("/purchase-plan", createPurchasePlanHandler(purchasePlanService));
  router.post("/purchase-plan/:planId/approve", createApprovePurchasePlanHandler(purchasePlanService));
  const paymentService = new PaymentExecutionService(paymentProvider, plans, products);
  router.post("/paypal/order", createPayPalOrderHandler(paymentService));
  router.post("/paypal/capture", createPayPalCaptureHandler(paymentService));
  router.get("/purchase-plan/:planId/status", createPurchasePlanStatusHandler(paymentService));
  return router;
}

export function createPayPalOrderHandler(service: PaymentExecutionService): RequestHandler {
  const bodySchema = z.object({ purchasePlanId: z.string().uuid() }).strict();
  return async (request: Request, response: Response) => {
    const parsedRequest = bodySchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_PAYPAL_ORDER_REQUEST", message: "Only a valid purchase plan ID may be supplied." }
      });
      return;
    }

    try {
      const result = await service.createOrder(parsedRequest.data.purchasePlanId);
      response.json({ success: true, ...result });
    } catch (error) {
      const failureEvent = createAgentEvent(
        "PAYPAL_ORDER_FAILED",
        "RELAY did not receive a usable PayPal approval URL.",
        new Date().toISOString()
      );
      if (error instanceof PaymentPlanNotFoundError) {
        response.status(404).json({ success: false, events: [failureEvent], error: { code: "PURCHASE_PLAN_NOT_FOUND", message: "Purchase plan was not found." } });
        return;
      }
      if (error instanceof PaymentPlanStateError) {
        response.status(409).json({ success: false, events: [failureEvent], error: { code: "PURCHASE_PLAN_NOT_APPROVED", message: "Only an approved, verified purchase plan can create a PayPal order." } });
        return;
      }
      if (error instanceof PaymentConfigurationError) {
        response.status(503).json({
          success: false,
          events: [failureEvent],
          error: { code: "PAYPAL_NOT_CONFIGURED", message: "PayPal Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server." }
        });
        return;
      }
      if (error instanceof PaymentTimeoutError) {
        response.status(504).json({ success: false, events: [failureEvent], error: { code: "PAYPAL_TIMEOUT", message: "PayPal Sandbox did not respond in time. Please retry." } });
        return;
      }
      if (error instanceof InvalidPaymentResponseError) {
        response.status(502).json({ success: false, events: [failureEvent], error: { code: "INVALID_PAYPAL_RESPONSE", message: "RELAY could not validate the PayPal order response." } });
        return;
      }
      if (error instanceof PaymentProviderError) {
        response.status(502).json({ success: false, events: [failureEvent], error: { code: "PAYPAL_PROVIDER_ERROR", message: "PayPal Sandbox is temporarily unavailable. Please retry." } });
        return;
      }
      console.error("Unexpected PayPal order creation error.");
      response.status(500).json({ success: false, events: [failureEvent], error: { code: "PAYPAL_ORDER_ERROR", message: "RELAY could not create a PayPal order." } });
    }
  };
}

export function createPayPalCaptureHandler(service: PaymentExecutionService): RequestHandler {
  const bodySchema = z.object({
    purchasePlanId: z.string().uuid(),
    paypalOrderId: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/)
  }).strict();
  return async (request: Request, response: Response) => {
    const parsedRequest = bodySchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_PAYPAL_CAPTURE_REQUEST", message: "A valid plan ID and PayPal order ID are required." }
      });
      return;
    }

    try {
      const result = await service.capture(parsedRequest.data.purchasePlanId, parsedRequest.data.paypalOrderId);
      if (result.failure) {
        response.status(502).json({
          success: false,
          plan: result.plan,
          product: result.product,
          events: result.events,
          error: { code: result.failure.code, message: result.failure.message }
        });
        return;
      }
      response.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof PaymentPlanNotFoundError) {
        response.status(404).json({ success: false, error: { code: "PURCHASE_PLAN_NOT_FOUND", message: "Purchase plan was not found." } });
        return;
      }
      if (error instanceof PaymentOrderMismatchError) {
        response.status(409).json({ success: false, error: { code: "PAYPAL_ORDER_MISMATCH", message: "PayPal order does not match this purchase plan." } });
        return;
      }
      if (error instanceof PaymentPlanStateError) {
        response.status(409).json({ success: false, error: { code: "PURCHASE_PLAN_NOT_EXECUTABLE", message: "This purchase plan cannot be captured in its current state." } });
        return;
      }
      if (error instanceof PaymentConfigurationError) {
        response.status(503).json({
          success: false,
          error: { code: "PAYPAL_NOT_CONFIGURED", message: "PayPal Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server." }
        });
        return;
      }
      if (error instanceof PaymentTimeoutError) {
        response.status(504).json({ success: false, error: { code: "PAYPAL_TIMEOUT", message: "PayPal Sandbox did not respond in time." } });
        return;
      }
      if (error instanceof InvalidPaymentResponseError) {
        response.status(502).json({ success: false, error: { code: "INVALID_PAYPAL_RESPONSE", message: "RELAY could not validate the PayPal capture response." } });
        return;
      }
      if (error instanceof PaymentProviderError) {
        response.status(502).json({ success: false, error: { code: "PAYPAL_PROVIDER_ERROR", message: "PayPal Sandbox is temporarily unavailable." } });
        return;
      }
      console.error("Unexpected PayPal capture error.");
      response.status(500).json({ success: false, error: { code: "PAYPAL_CAPTURE_ERROR", message: "RELAY could not complete PayPal capture." } });
    }
  };
}

export function createPurchasePlanStatusHandler(service: PaymentExecutionService): RequestHandler {
  return async (request: Request, response: Response) => {
    const planId = z.string().uuid().safeParse(request.params.planId);
    if (!planId.success) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_PURCHASE_PLAN_ID", message: "A valid purchase plan ID is required." }
      });
      return;
    }
    try {
      const transaction = await service.getTransactionStatus(planId.data);
      if (!transaction) {
        response.status(404).json({
          success: false,
          error: { code: "PURCHASE_PLAN_NOT_FOUND", message: "RELAY could not find this transaction in the current server session." }
        });
        return;
      }
      response.json({ success: true, ...transaction });
    } catch (error) {
      if (error instanceof PaymentConfigurationError) {
        response.status(503).json({
          success: false,
          error: { code: "PAYPAL_NOT_CONFIGURED", message: "PayPal Sandbox status checks are not configured on the server." }
        });
        return;
      }
      if (error instanceof PaymentTimeoutError) {
        response.status(504).json({
          success: false,
          error: { code: "PAYPAL_STATUS_TIMEOUT", message: "PayPal Sandbox status could not be refreshed in time. Try again." }
        });
        return;
      }
      if (error instanceof InvalidPaymentResponseError || error instanceof PaymentProviderError) {
        response.status(502).json({
          success: false,
          error: { code: "PAYPAL_STATUS_UNAVAILABLE", message: "RELAY could not verify the latest PayPal status. Try again." }
        });
        return;
      }
      console.error("Unexpected transaction status refresh error.");
      response.status(500).json({
        success: false,
        error: { code: "TRANSACTION_STATUS_ERROR", message: "RELAY could not refresh this transaction status." }
      });
    }
  };
}

export function createAgentIntentHandler(provider: AIProvider): RequestHandler {
  const intentService = new ShoppingIntentService(provider);
  return async (request: Request, response: Response) => {
    const requestStartedAt = performance.now();
    const requestReceivedEvent = createAgentEvent(
      "REQUEST_RECEIVED",
      "RELAY received the shopping request.",
      new Date().toISOString()
    );
    if (process.env.NODE_ENV !== "production") {
      console.info("INTENT_REQUEST_RECEIVED");
    }
    const sendJson = (statusCode: number, body: unknown) => {
      if (statusCode !== 200) response.status(statusCode);
      if (process.env.NODE_ENV !== "production") {
        console.info("INTENT_RESPONSE_SENT", {
          statusCode,
          totalDurationMs: Math.round(performance.now() - requestStartedAt)
        });
      }
      response.json(body);
    };

    const parsedRequest = intentRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      sendJson(400, {
        success: false,
        error: { code: "INVALID_REQUEST", message: "Request body must contain a shopping request string." }
      });
      return;
    }

    try {
      const intent = await intentService.parse(parsedRequest.data.request);
      sendJson(200, {
        success: true,
        intent,
        events: [
          requestReceivedEvent,
          createAgentEvent("INTENT_PARSED", "Gemini interpreted the request; RELAY validated the structured shopping intent.", new Date().toISOString())
        ]
      });
    } catch (error) {
      if (error instanceof IntentRequestError) {
        sendJson(400, {
          success: false,
          error: { code: error.code, message: error.message }
        });
        return;
      }

      if (error instanceof AIConfigurationError) {
        sendJson(503, {
          success: false,
          error: {
            code: "AI_NOT_CONFIGURED",
            message: "Gemini is not configured. Set GEMINI_API_KEY in the server environment and restart RELAY."
          }
        });
        return;
      }

      if (error instanceof InvalidAIOutputError) {
        sendJson(502, {
          success: false,
          error: { code: "INVALID_AI_RESPONSE", message: "RELAY could not validate the interpreted request. Please try again." }
        });
        return;
      }

      if (error instanceof AIProviderError) {
        sendJson(502, {
          success: false,
          error: { code: "AI_PROVIDER_ERROR", message: "The intent service is temporarily unavailable. Please try again." }
        });
        return;
      }

      console.error("Unexpected shopping intent error.");
      sendJson(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "RELAY could not process this request. Please try again." }
      });
    }
  };
}

export function createAgentProductsHandler(
  commerceProvider: CommerceProvider,
  productRepository: ProductRepository
): RequestHandler {
  const discoveryService = new ProductDiscoveryService(commerceProvider);
  const bodySchema = z.object({ intent: ShoppingIntentSchema }).strict();
  return async (request: Request, response: Response) => {
    const parsedRequest = bodySchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_INTENT", message: "A valid shopping intent is required to search products." }
      });
      return;
    }

    try {
      const discovery = await discoveryService.findWithAudit(parsedRequest.data.intent);
      const candidates = discovery.candidates;
      const products = candidatesToProducts(candidates);
      productRepository.save(products, parsedRequest.data.intent);
      if (process.env.NODE_ENV !== "production") {
        console.info("PRODUCT_RESPONSE", {
          repositoryInstanceId: productRepository.instanceId,
          productCount: products.length,
          productIds: products.map((product) => product.id)
        });
      }
      response.json({ success: true, products, events: discovery.events });
    } catch (error) {
      if (error instanceof CommerceConfigurationError) {
        response.status(503).json({
          success: false,
          error: {
            code: "COMMERCE_NOT_CONFIGURED",
            message: "Channel3 is not configured. Set CHANNEL3_API_KEY in the server environment and restart RELAY."
          }
        });
        return;
      }

      if (error instanceof CommerceTimeoutError) {
        response.status(504).json({
          success: false,
          error: { code: "COMMERCE_TIMEOUT", message: "Product search took too long. Please try again." }
        });
        return;
      }

      if (error instanceof InvalidCommerceResponseError) {
        response.status(502).json({
          success: false,
          error: { code: "INVALID_COMMERCE_RESPONSE", message: "RELAY could not validate product data. Please try again." }
        });
        return;
      }

      if (error instanceof CommerceProviderError) {
        response.status(502).json({
          success: false,
          error: { code: "COMMERCE_PROVIDER_ERROR", message: "The product search service is temporarily unavailable. Please try again." }
        });
        return;
      }

      console.error("Unexpected product discovery error.");
      response.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "RELAY could not search products. Please try again." }
      });
    }
  };
}

function createAgentEvent(type: AgentEvent["type"], message: string, createdAt: string): AgentEvent {
  return { id: randomUUID(), type, message, createdAt };
}

export function createPurchasePlanHandler(service: PurchasePlanService): RequestHandler {
  return (request: Request, response: Response) => {
    if (process.env.NODE_ENV !== "production") {
      const body = typeof request.body === "object" && request.body !== null
        ? request.body as Record<string, unknown>
        : {};
      console.info("PURCHASE_REQUEST", {
        productId: typeof body.productId === "string" ? body.productId : undefined,
        repositoryInstanceId: service.productRepositoryInstanceId
      });
    }
    const parsedRequest = PurchasePlanRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_PURCHASE_PLAN_REQUEST", message: "A valid product ID, quantity, and policy are required." }
      });
      return;
    }

    try {
      const result = service.create(parsedRequest.data);
      response.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof PurchaseQuantityMismatchError) {
        response.status(400).json({
          success: false,
          error: {
            code: "PURCHASE_QUANTITY_MISMATCH",
            message: "Purchase quantity must match the quantity in the verified shopping request. Search again to review the request."
          }
        });
        return;
      }
      if (error instanceof InvalidUserPolicyError) {
        response.status(400).json({
          success: false,
          error: { code: "INVALID_POLICY", message: "Policy amounts must use valid precision for the configured currency." }
        });
        return;
      }
      if (error instanceof ProductNotVerifiedError) {
        response.status(404).json({
          success: false,
          error: { code: "PRODUCT_NOT_VERIFIED", message: "That product is no longer available in RELAY's verified search context. Search again." }
        });
        return;
      }
      console.error("Unexpected purchase plan creation error.");
      response.status(500).json({
        success: false,
        error: { code: "PURCHASE_PLAN_ERROR", message: "RELAY could not create a purchase plan. Please try again." }
      });
    }
  };
}

export function createApprovePurchasePlanHandler(service: PurchasePlanService): RequestHandler {
  const bodySchema = ApprovePurchasePlanRequestSchema;
  return (request: Request, response: Response) => {
    const parsedBody = bodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success || typeof request.params.planId !== "string") {
      response.status(400).json({
        success: false,
        error: { code: "INVALID_APPROVAL_REQUEST", message: "A valid purchase plan approval request is required." }
      });
      return;
    }
    try {
      const result = service.approve(request.params.planId);
      response.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof ProductNotVerifiedError || error instanceof PlanNotApprovableError) {
        response.status(409).json({
          success: false,
          error: { code: "PLAN_NOT_APPROVABLE", message: "This plan cannot be approved. Create a new verified plan." }
        });
        return;
      }
      console.error("Unexpected purchase plan approval error.");
      response.status(500).json({
        success: false,
        error: { code: "PURCHASE_PLAN_ERROR", message: "RELAY could not approve this plan. Please try again." }
      });
    }
  };
}
