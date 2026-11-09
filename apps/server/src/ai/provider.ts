import type { ShoppingIntent } from "@relay/shared";

export interface AIProvider {
  parseShoppingIntent(request: string): Promise<ShoppingIntent>;
}

export class AIConfigurationError extends Error {
  constructor() {
    super("The AI provider is not configured.");
    this.name = "AIConfigurationError";
  }
}

export class AIProviderError extends Error {
  constructor() {
    super("The AI provider request failed.");
    this.name = "AIProviderError";
  }
}

export class InvalidAIOutputError extends Error {
  constructor() {
    super("The AI provider returned an invalid shopping intent.");
    this.name = "InvalidAIOutputError";
  }
}
