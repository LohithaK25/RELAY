import { ShoppingIntentSchema, type ShoppingIntent } from "@relay/shared";
import type { AIProvider } from "./provider.js";

const MAX_REQUEST_LENGTH = 2_000;

export function normalizeExplicitINRBudget(request: string): ShoppingIntent["budget"] | undefined {
  const amountPattern = "(?:₹|INR\\b|Rs\\.?\\s*)\\s*([\\d,]+(?:\\.\\d+)?)\\s*(lakhs?|lacs?|crores?|cr)?";
  const budgetQualifier = "\\b(?:under|below|less than|up to|upto|within|budget(?: of)?|maximum|max|at most|not more than)\\s*";
  const beforeAmount = request.match(new RegExp(`${budgetQualifier}${amountPattern}`, "i"));
  const afterAmount = request.match(new RegExp(`${amountPattern}\\s*(?:max|maximum|or less)\\b`, "i"));
  const match = beforeAmount ?? afterAmount;
  if (!match) return undefined;

  const numericAmount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return undefined;

  const unit = match[2]?.toLowerCase();
  const multiplier = unit?.startsWith("l") ? 100_000 : unit?.startsWith("c") ? 10_000_000 : 1;
  return { amount: numericAmount * multiplier, currency: "INR" };
}

export class ShoppingIntentService {
  constructor(private readonly provider: AIProvider) {}

  async parse(request: string): Promise<ShoppingIntent> {
    const trimmedRequest = request.trim();
    if (!trimmedRequest) {
      throw new IntentRequestError("EMPTY_REQUEST", "Enter a shopping request to continue.");
    }
    if (trimmedRequest.length > MAX_REQUEST_LENGTH) {
      throw new IntentRequestError("REQUEST_TOO_LONG", `Requests must be ${MAX_REQUEST_LENGTH} characters or fewer.`);
    }

    const intent = await this.provider.parseShoppingIntent(trimmedRequest);
    const normalizedBudget = normalizeExplicitINRBudget(trimmedRequest);
    const validatedIntent = ShoppingIntentSchema.parse({
      ...intent,
      originalRequest: trimmedRequest,
      budget: normalizedBudget ?? intent.budget
    });

    return validatedIntent;
  }
}

export class IntentRequestError extends Error {
  constructor(
    readonly code: "EMPTY_REQUEST" | "REQUEST_TOO_LONG",
    message: string
  ) {
    super(message);
    this.name = "IntentRequestError";
  }
}
