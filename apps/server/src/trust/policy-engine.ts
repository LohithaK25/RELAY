import { PolicyDecisionSchema, type PolicyDecision, type Product } from "@relay/shared";
import { assertCurrencyMatch, calculateTotalMinor, compareMinor, parseMajorToMinor } from "./money.js";
import type { PolicyCheck, PolicyEvaluationInput } from "./policy-types.js";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^www\./, "");
}

function check(name: PolicyCheck["name"], passed: boolean, message: string, value?: string | number | boolean): PolicyCheck {
  return { name, passed, message, ...(value === undefined ? {} : { value }) };
}

export interface EvaluatedPolicy {
  decision: PolicyDecision;
  unitPriceMinor: number | null;
  totalMinor: number | null;
}

export function evaluatePolicy(input: PolicyEvaluationInput, evaluatedAt = new Date().toISOString()): EvaluatedPolicy {
  const { intent, product, quantity, policy } = input;
  let unitPriceMinor: number | null = null;
  let totalMinor: number | null = null;
  let moneyValid = false;

  if (product.price && product.merchant) {
    try {
      assertCurrencyMatch(policy.currency, product.price.currency);
      unitPriceMinor = parseMajorToMinor(product.price.amount, product.price.currency);
      totalMinor = calculateTotalMinor(unitPriceMinor, quantity);
      moneyValid = true;
    } catch {
      moneyValid = false;
    }
  }

  const category = product.category ? normalized(product.category) : "";
  const merchant = product.merchant ? normalized(product.merchant) : "";
  const allowedCategories = policy.allowedCategories.map(normalized);
  const blockedCategories = policy.blockedCategories.map(normalized);
  const allowedMerchants = policy.allowedMerchants.map(normalized);
  const blockedMerchants = policy.blockedMerchants.map(normalized);
  const categoryAllowed = allowedCategories.length === 0 || allowedCategories.includes(category);
  const categoryNotBlocked = !category || !blockedCategories.includes(category);
  const merchantAllowed = allowedMerchants.length === 0 || allowedMerchants.includes(merchant);
  const merchantNotBlocked = !merchant || !blockedMerchants.includes(merchant);
  const transactionLimitMinor = parseMajorToMinor(policy.maxTransactionAmount, policy.currency);
  const itemLimitMinor = parseMajorToMinor(policy.maxItemPrice, policy.currency);
  const intentBudgetCompatible = !intent.budget || intent.budget.currency === policy.currency;
  const intentBudgetMinor = intent.budget && intentBudgetCompatible
    ? parseMajorToMinor(intent.budget.amount, intent.budget.currency)
    : Number.MAX_SAFE_INTEGER;
  const effectiveTotalLimit = Math.min(transactionLimitMinor, intentBudgetMinor);
  const effectiveItemLimit = Math.min(itemLimitMinor, intentBudgetMinor);

  const checks: PolicyCheck[] = [
    check("PRODUCT_VERIFIED", moneyValid && product.availability === "in_stock", moneyValid && product.availability === "in_stock"
      ? "Product has a verified Channel3 price, currency, merchant, and in-stock offer."
      : "Product must have a verified in-stock offer, price, matching currency, and merchant."),
    check("TRANSACTION_LIMIT",
      moneyValid && intentBudgetCompatible && compareMinor(totalMinor!, effectiveTotalLimit) <= 0,
      moneyValid && intentBudgetCompatible && compareMinor(totalMinor!, effectiveTotalLimit) <= 0
        ? "Total is within the configured transaction and request budget limits."
        : "Total exceeds a configured transaction limit or the request budget.",
      moneyValid ? totalMinor! : undefined),
    check("ITEM_PRICE_LIMIT",
      moneyValid && intentBudgetCompatible && compareMinor(unitPriceMinor!, effectiveItemLimit) <= 0,
      moneyValid && intentBudgetCompatible && compareMinor(unitPriceMinor!, effectiveItemLimit) <= 0
        ? "Product price is within the configured item price limit."
        : "Product price exceeds the configured item price limit.",
      moneyValid ? unitPriceMinor! : undefined),
    check("QUANTITY_LIMIT", Number.isSafeInteger(quantity) && quantity > 0 && quantity <= policy.maxQuantity,
      Number.isSafeInteger(quantity) && quantity > 0 && quantity <= policy.maxQuantity
        ? "Quantity is within the configured limit."
        : `Requested quantity ${quantity} exceeds the configured limit of ${policy.maxQuantity}.`,
      quantity),
    check("CATEGORY_ALLOWLIST", categoryAllowed,
      categoryAllowed ? "Product category is permitted." : "Product category is not on the allowed list.",
      product.category ?? undefined),
    check("CATEGORY_BLOCKLIST", categoryNotBlocked,
      categoryNotBlocked ? "Product category is not blocked." : "Product category is blocked.",
      product.category ?? undefined),
    check("MERCHANT_ALLOWLIST", merchantAllowed,
      merchantAllowed ? "Merchant is permitted." : "Merchant is not on the allowed list.",
      product.merchant ?? undefined),
    check("MERCHANT_BLOCKLIST", merchantNotBlocked,
      merchantNotBlocked ? "Merchant is not blocked." : "Merchant is blocked.",
      product.merchant ?? undefined)
  ];

  const amountBelowAutoApproval = totalMinor !== null &&
    compareMinor(totalMinor, parseMajorToMinor(policy.autoApproveBelow, policy.currency)) <= 0;
  const requiresApproval = policy.requireApproval || !amountBelowAutoApproval;
  checks.push(check("APPROVAL_REQUIRED", true,
    requiresApproval ? "Explicit user approval is required before execution." : "Policy permits automatic approval below its configured threshold.",
    requiresApproval));

  const decision = PolicyDecisionSchema.parse({
    allowed: checks.filter((item) => item.name !== "APPROVAL_REQUIRED").every((item) => item.passed),
    requiresApproval,
    checks,
    evaluatedAt
  });

  return { decision, unitPriceMinor, totalMinor };
}

export function isPriceCurrencyMatch(product: Product, currency: string): boolean {
  if (!product.price) return false;
  try {
    assertCurrencyMatch(currency, product.price.currency);
    parseMajorToMinor(product.price.amount, product.price.currency);
    return true;
  } catch {
    return false;
  }
}
