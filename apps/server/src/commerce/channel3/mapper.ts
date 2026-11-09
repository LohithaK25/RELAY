import { ProductCandidateSchema, type ProductCandidate } from "@relay/shared";
import type { ShoppingIntent } from "@relay/shared";
import { channel3ProductSchema, type Channel3Product } from "./schemas.js";
import { InvalidCommerceResponseError } from "../provider.js";

function getMerchantName(domain: string): string {
  return domain.toLocaleLowerCase().replace(/^www\./, "");
}

function mapOneProduct(input: Channel3Product, intent: ShoppingIntent): ProductCandidate | null {
  const offers = [...(input.offers ?? [])].sort((left, right) => {
    const leftCurrency = intent.budget?.currency === left.price.currency ? 0 : 1;
    const rightCurrency = intent.budget?.currency === right.price.currency ? 0 : 1;
    return leftCurrency - rightCurrency ||
      Number(right.availability === "InStock") - Number(left.availability === "InStock") ||
      left.price.price - right.price.price ||
      left.domain.localeCompare(right.domain);
  });
  const offer = offers[0];
  const image = input.images?.find((item) => item.cleaned_url)?.cleaned_url
    ?? input.images?.find((item) => item.is_main_image)?.url
    ?? input.images?.[0]?.url
    ?? null;

  const attributes: Record<string, string> = {};
  const brandNames = input.brands?.map((brand) => brand.name).filter(Boolean) ?? [];
  if (brandNames.length) attributes.brand = brandNames.join(", ");
  if (input.materials?.length) attributes.materials = input.materials.join(", ");
  if (input.key_features?.length) attributes.features = input.key_features.join(", ");
  for (const [key, values] of Object.entries(input.structured_attributes ?? {})) {
    if (values.length) attributes[key] = values.join(", ");
  }

  return ProductCandidateSchema.parse({
    product: {
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      imageUrl: image,
      productUrl: offer?.url ?? null,
      merchant: offer ? getMerchantName(offer.domain) : null,
      price: offer ? { amount: offer.price.price, currency: offer.price.currency } : null,
      availability: offer
        ? offer.availability === "InStock" ? "in_stock" : "out_of_stock"
        : "unknown",
      category: input.category?.title ?? input.category?.slug ?? null,
      attributes,
      source: "channel3"
    },
    score: 0,
    reasoning: ""
  });
}

export function mapChannel3Product(value: unknown, intent: ShoppingIntent): ProductCandidate | null {
  const parsed = channel3ProductSchema.safeParse(value);
  if (!parsed.success) throw new InvalidCommerceResponseError();
  return mapOneProduct(parsed.data, intent);
}

export function mapChannel3Products(values: unknown[], intent: ShoppingIntent): ProductCandidate[] {
  return values.map((value) => mapChannel3Product(value, intent))
    .filter((candidate): candidate is ProductCandidate => candidate !== null);
}
