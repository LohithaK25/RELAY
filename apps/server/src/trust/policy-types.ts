import type { Policy, PolicyDecision, Product, ShoppingIntent } from "@relay/shared";

export type UserPolicy = Policy;
export type PolicyCheck = PolicyDecision["checks"][number];

export interface PolicyEvaluationInput {
  intent: ShoppingIntent;
  product: Product;
  quantity: number;
  policy: UserPolicy;
}

export interface PolicyConfiguration {
  defaultPolicy: UserPolicy;
}
