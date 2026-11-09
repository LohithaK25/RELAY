import { randomUUID } from "node:crypto";
import {
  ProductCandidateSchema,
  ProductSchema,
  type AgentEvent,
  type ProductCandidate,
  type ShoppingIntent
} from "@relay/shared";
import { InvalidCommerceResponseError } from "./provider.js";
import type { CommerceProvider } from "./provider.js";
import { calculateTotalMinor, compareMinor, MoneyError, parseMajorToMinor } from "../trust/money.js";

export const MAX_RECOMMENDATIONS = 5;

export function buildCommerceQuery(intent: ShoppingIntent): string {
  return [
    intent.productType,
    intent.category,
    ...intent.requiredAttributes,
    ...intent.preferredAttributes,
    intent.budget ? `${intent.budget.amount} ${intent.budget.currency} maximum` : null,
    intent.location,
    intent.country,
    intent.deliveryRequirement
  ].filter((part): part is string => Boolean(part?.trim())).join(" ");
}

function searchableText(candidate: ProductCandidate): string {
  return [
    candidate.product.title,
    candidate.product.description ?? "",
    candidate.product.category ?? "",
    ...Object.entries(candidate.product.attributes).flatMap(([key, value]) => [key, value])
  ].join(" ").toLocaleLowerCase();
}

function matchesAny(text: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (text.includes(term.toLocaleLowerCase()) ? 1 : 0), 0);
}

export function filterAndRankProducts(
  candidates: ProductCandidate[],
  intent: ShoppingIntent,
  limit = MAX_RECOMMENDATIONS,
  onFiltered?: (eligibleCount: number) => void
): ProductCandidate[] {
  const rejected = {
    unavailable: 0,
    currencyMismatch: 0,
    budget: 0,
    requiredAttributes: 0,
    excludedAttributes: 0
  };
  const requiredAttributeMisses: { productId: string; missingAttributes: string[] }[] = [];
  const requiredAttributeMissingCounts = Object.fromEntries(
    intent.requiredAttributes.map((attribute) => [attribute, 0])
  );
  const intentBudgetMinor = intent.budget
    ? parseMajorToMinor(intent.budget.amount, intent.budget.currency)
    : null;
  const eligible = candidates
    .map((candidate) => {
      const validated = ProductCandidateSchema.safeParse(candidate);
      if (!validated.success) throw new InvalidCommerceResponseError();
      const product = validated.data.product;
      const text = searchableText(validated.data);

      if (product.availability !== "in_stock") {
        rejected.unavailable += 1;
        return null;
      }
      const missingAttributes = intent.requiredAttributes.filter(
        (attribute) => !text.includes(attribute.toLocaleLowerCase())
      );
      if (missingAttributes.length > 0) {
        rejected.requiredAttributes += 1;
        for (const attribute of missingAttributes) {
          requiredAttributeMissingCounts[attribute] += 1;
        }
        requiredAttributeMisses.push({ productId: product.id, missingAttributes });
        return null;
      }
      if (intent.excludedAttributes.some((attribute) => text.includes(attribute.toLocaleLowerCase()))) {
        rejected.excludedAttributes += 1;
        return null;
      }
      if (intent.budget) {
        if (product.price && product.price.currency !== intent.budget.currency) {
          rejected.currencyMismatch += 1;
          return null;
        }
        let candidateTotalMinor: number;
        try {
          if (!product.price) throw new MoneyError("Product price is missing.");
          candidateTotalMinor = calculateTotalMinor(
            parseMajorToMinor(product.price.amount, product.price.currency),
            intent.quantity
          );
        } catch (error) {
          if (!(error instanceof MoneyError)) throw error;
          rejected.budget += 1;
          return null;
        }
        if (compareMinor(candidateTotalMinor, intentBudgetMinor!) > 0) {
          rejected.budget += 1;
          return null;
        }
      }

      const preferredMatches = matchesAny(text, intent.preferredAttributes);
      const priceValue = intent.budget && product.price
        ? 1 - product.price.amount * intent.quantity / intent.budget.amount
        : 0;
      const availabilityValue = product.availability === "in_stock" ? 1 : 0;
      const score = Math.min(1, preferredMatches * 0.3 + priceValue * 0.5 + availabilityValue * 0.1);
      const reasoning = [
        preferredMatches > 0 ? `${preferredMatches} preference${preferredMatches === 1 ? "" : "s"} matched` : null,
        intent.budget && product.price ? "within budget" : null,
        product.availability === "in_stock" ? "in stock" : null
      ].filter((part): part is string => part !== null).join(", ");

      return ProductCandidateSchema.parse({ ...validated.data, score, reasoning });
    })
    .filter((candidate): candidate is ProductCandidate => candidate !== null);
  onFiltered?.(eligible.length);

  const ranked = eligible.sort((left, right) => {
    const leftPrice = left.product.price;
    const rightPrice = right.product.price;
    const priceOrder = leftPrice && rightPrice
      ? leftPrice.currency === rightPrice.currency
        ? leftPrice.amount - rightPrice.amount
        : leftPrice.currency.localeCompare(rightPrice.currency)
      : leftPrice ? -1 : rightPrice ? 1 : 0;
    return right.score - left.score ||
      priceOrder ||
      left.product.title.localeCompare(right.product.title) ||
      left.product.id.localeCompare(right.product.id);
  }).slice(0, limit);
  if (process.env.NODE_ENV !== "production") {
    console.info("PRODUCT_FILTER_SUMMARY", {
      inputCount: candidates.length,
      rejected,
      requiredAttributeMissingCounts,
      requiredAttributeMisses: requiredAttributeMisses.slice(0, 20),
      remainingAfterFiltering: eligible.length,
      rankedCount: ranked.length,
      rankedProductIds: ranked.map((candidate) => candidate.product.id)
    });
  }
  return ranked;
}

export class ProductDiscoveryService {
  constructor(private readonly provider: CommerceProvider) {}

  async find(intent: ShoppingIntent): Promise<ProductCandidate[]> {
    const candidates = await this.provider.search(intent);
    return filterAndRankProducts(candidates, intent);
  }

  async findWithAudit(intent: ShoppingIntent): Promise<{ candidates: ProductCandidate[]; events: AgentEvent[] }> {
    const rawCandidates = await this.provider.search(intent);
    const events: AgentEvent[] = [
      createEvent("PRODUCTS_DISCOVERED", `Channel3 discovery returned ${rawCandidates.length} product candidate(s).`)
    ];
    const candidates = filterAndRankProducts(rawCandidates, intent, MAX_RECOMMENDATIONS, (eligibleCount) => {
      events.push(createEvent(
        "PRODUCTS_FILTERED",
        `Deterministic availability, currency, budget, and attribute checks retained ${eligibleCount} of ${rawCandidates.length} candidate(s).`
      ));
    });
    events.push(createEvent(
      "PRODUCTS_RANKED",
      `Recommendations were deterministically ranked; ${candidates.length} result(s) are ready for review.`
    ));
    return { candidates, events };
  }
}

export function candidatesToProducts(candidates: ProductCandidate[]) {
  return candidates.map(({ product }) => ProductSchema.parse(product));
}

function createEvent(type: AgentEvent["type"], message: string): AgentEvent {
  return { id: randomUUID(), type, message, createdAt: new Date().toISOString() };
}
