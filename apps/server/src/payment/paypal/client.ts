import { z } from "zod";
import {
  InvalidPaymentResponseError,
  PaymentConfigurationError,
  PaymentProviderError,
  PaymentTimeoutError
} from "../provider.js";
import type { PaymentProvider, PayPalCreateOrderInput, PayPalOrder } from "../provider.js";

const PayPalLinkSchema = z.object({
  href: z.string().url(),
  rel: z.string()
}).passthrough();

const PayPalCaptureSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: z.object({
    value: z.string().regex(/^\d+(?:\.\d+)?$/),
    currency_code: z.string().length(3)
  }).passthrough()
}).passthrough();

const PayPalOrderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(PayPalLinkSchema).optional(),
  purchase_units: z.array(z.object({
    payments: z.object({
      captures: z.array(PayPalCaptureSchema).optional()
    }).passthrough().optional()
  }).passthrough()).optional()
}).passthrough();

interface PayPalClientConfiguration {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class PayPalClient implements PaymentProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly configuration: PayPalClientConfiguration = process.env) {
    this.baseUrl = (configuration.baseUrl || "https://api-m.sandbox.paypal.com").replace(/\/+$/, "");
    this.timeoutMs = configuration.timeoutMs ?? 12_000;
  }

  async createOrder(input: PayPalCreateOrderInput): Promise<{ id: string; approvalUrl: string }> {
    const body = await this.request("/v2/checkout/orders", {
      method: "POST",
      requestId: input.requestId,
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: input.purchasePlanId,
          description: input.description.slice(0, 127),
          amount: { currency_code: input.currency, value: input.amount }
        }],
        application_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          user_action: "PAY_NOW"
        }
      }
    });
    const parsed = PayPalOrderSchema.safeParse(body);
    const approvalUrl = parsed.success ? parsed.data.links?.find((link) => link.rel === "approve")?.href : undefined;
    if (!parsed.success || !approvalUrl || !isPayPalApprovalUrl(approvalUrl)) throw new InvalidPaymentResponseError();
    return { id: parsed.data.id, approvalUrl };
  }

  async captureOrder(orderId: string, requestId: string): Promise<void> {
    await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      requestId,
      body: {}
    });
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
    const parsed = PayPalOrderSchema.safeParse(body);
    if (!parsed.success) throw new InvalidPaymentResponseError();
    return {
      id: parsed.data.id,
      status: parsed.data.status,
      purchaseUnits: (parsed.data.purchase_units ?? []).map((unit) => ({
        captures: (unit.payments?.captures ?? []).map((capture) => ({
          id: capture.id,
          status: capture.status,
          amount: capture.amount.value,
          currency: capture.amount.currency_code
        }))
      }))
    };
  }

  private async request(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown; requestId?: string }
  ): Promise<unknown> {
    const { clientId, clientSecret } = this.configuration;
    let apiUrl: URL;
    try {
      apiUrl = new URL(this.baseUrl);
    } catch {
      throw new PaymentConfigurationError();
    }
    if (
      !clientId ||
      !clientSecret ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      apiUrl.protocol !== "https:" ||
      apiUrl.hostname !== "api-m.sandbox.paypal.com" ||
      apiUrl.pathname !== "/"
    ) {
      throw new PaymentConfigurationError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const tokenResponse = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials",
        signal: controller.signal
      });
      if (!tokenResponse.ok) throw new PaymentProviderError();
      const tokenBody = await readJson(tokenResponse);
      const token = z.object({ access_token: z.string().min(1) }).safeParse(tokenBody);
      if (!token.success) throw new InvalidPaymentResponseError();

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${token.data.access_token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.requestId ? { "PayPal-Request-Id": options.requestId } : {})
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal
      });
      if (!response.ok) throw new PaymentProviderError();
      return await readJson(response);
    } catch (error) {
      if (error instanceof PaymentProviderError || error instanceof InvalidPaymentResponseError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new PaymentTimeoutError();
      throw new PaymentProviderError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new InvalidPaymentResponseError();
  }
}

function isPayPalApprovalUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" &&
    url.port === "" &&
    (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
}

export function createPayPalPaymentProvider(environment: NodeJS.ProcessEnv = process.env): PaymentProvider {
  return new PayPalClient({
    clientId: environment.PAYPAL_CLIENT_ID,
    clientSecret: environment.PAYPAL_CLIENT_SECRET,
    baseUrl: environment.PAYPAL_BASE_URL,
    timeoutMs: Number(environment.PAYPAL_TIMEOUT_MS ?? 12_000)
  });
}
