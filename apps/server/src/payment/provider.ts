export interface PayPalCreateOrderInput {
  purchasePlanId: string;
  amount: string;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  approvalUrl?: string;
  purchaseUnits: Array<{
    captures: Array<{
      id: string;
      status: string;
      amount: string;
      currency: string;
    }>;
  }>;
}

export interface PaymentProvider {
  createOrder(input: PayPalCreateOrderInput): Promise<{ id: string; approvalUrl: string }>;
  captureOrder(orderId: string, requestId: string): Promise<void>;
  getOrder(orderId: string): Promise<PayPalOrder>;
}

export class PaymentConfigurationError extends Error {
  constructor() {
    super("PayPal Sandbox is not configured.");
    this.name = "PaymentConfigurationError";
  }
}

export class PaymentTimeoutError extends Error {
  constructor() {
    super("PayPal Sandbox request timed out.");
    this.name = "PaymentTimeoutError";
  }
}

export class PaymentProviderError extends Error {
  constructor() {
    super("PayPal Sandbox request failed.");
    this.name = "PaymentProviderError";
  }
}

export class InvalidPaymentResponseError extends Error {
  constructor() {
    super("PayPal returned an invalid response.");
    this.name = "InvalidPaymentResponseError";
  }
}
