import type { ProductCandidate, ShoppingIntent } from "@relay/shared";

export interface CommerceProvider {
  search(intent: ShoppingIntent): Promise<ProductCandidate[]>;
}

export class CommerceConfigurationError extends Error {
  constructor() {
    super("The commerce provider is not configured.");
    this.name = "CommerceConfigurationError";
  }
}

export class CommerceTimeoutError extends Error {
  constructor() {
    super("The commerce provider request timed out.");
    this.name = "CommerceTimeoutError";
  }
}

export class CommerceProviderError extends Error {
  constructor() {
    super("The commerce provider request failed.");
    this.name = "CommerceProviderError";
  }
}

export class InvalidCommerceResponseError extends Error {
  constructor() {
    super("The commerce provider returned invalid product data.");
    this.name = "InvalidCommerceResponseError";
  }
}
