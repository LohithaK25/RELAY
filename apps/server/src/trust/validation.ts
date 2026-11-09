import { PolicySchema } from "@relay/shared";
import { z } from "zod";
import type { Policy } from "@relay/shared";
import type { PolicyConfiguration } from "./policy-types.js";
import { MoneyError, parseMajorToMinor } from "./money.js";

export const UserPolicyInputSchema = PolicySchema.partial().strict();

export const PurchasePlanRequestSchema = z.object({
  productId: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  policy: UserPolicyInputSchema
}).passthrough();

export const ApprovePurchasePlanRequestSchema = z.object({}).strict();

export class InvalidUserPolicyError extends Error {
  constructor() {
    super("The supplied policy contains invalid money values.");
    this.name = "InvalidUserPolicyError";
  }
}

function parseConfiguredAmount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Configured policy amount must be a positive number.");
  return parsed;
}

function parseConfiguredQuantity(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Configured policy quantity must be a positive integer.");
  return parsed;
}

function listFromEnvironment(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

export function loadPolicyConfiguration(environment: NodeJS.ProcessEnv = process.env): PolicyConfiguration {
  const policy = PolicySchema.parse({
    maxTransactionAmount: parseConfiguredAmount(environment.RELAY_POLICY_MAX_TRANSACTION_AMOUNT, 120_000),
    currency: environment.RELAY_POLICY_CURRENCY?.trim().toUpperCase() || "INR",
    maxItemPrice: parseConfiguredAmount(environment.RELAY_POLICY_MAX_ITEM_PRICE, 120_000),
    maxQuantity: parseConfiguredQuantity(environment.RELAY_POLICY_MAX_QUANTITY, 1),
    allowedCategories: listFromEnvironment(environment.RELAY_POLICY_ALLOWED_CATEGORIES),
    blockedCategories: listFromEnvironment(environment.RELAY_POLICY_BLOCKED_CATEGORIES),
    allowedMerchants: listFromEnvironment(environment.RELAY_POLICY_ALLOWED_MERCHANTS),
    blockedMerchants: listFromEnvironment(environment.RELAY_POLICY_BLOCKED_MERCHANTS),
    requireApproval: true,
    autoApproveBelow: 0
  });
  return { defaultPolicy: policy };
}

function intersectAllowlist(serverList: string[], userList: string[]): string[] {
  if (serverList.length === 0) return userList;
  if (userList.length === 0) return serverList;
  const userValues = new Set(userList.map((value) => value.toLocaleLowerCase()));
  return serverList.filter((value) => userValues.has(value.toLocaleLowerCase()));
}

export function resolveEffectivePolicy(serverPolicy: Policy, input: Partial<Policy>): Policy {
  const currency = serverPolicy.currency;
  const resolved = PolicySchema.parse({
    maxTransactionAmount: Math.min(serverPolicy.maxTransactionAmount, input.maxTransactionAmount ?? serverPolicy.maxTransactionAmount),
    currency,
    maxItemPrice: Math.min(serverPolicy.maxItemPrice, input.maxItemPrice ?? serverPolicy.maxItemPrice),
    maxQuantity: Math.min(serverPolicy.maxQuantity, input.maxQuantity ?? serverPolicy.maxQuantity),
    allowedCategories: intersectAllowlist(serverPolicy.allowedCategories, input.allowedCategories ?? []),
    blockedCategories: [...new Set([...serverPolicy.blockedCategories, ...(input.blockedCategories ?? [])])],
    allowedMerchants: intersectAllowlist(serverPolicy.allowedMerchants, input.allowedMerchants ?? []),
    blockedMerchants: [...new Set([...serverPolicy.blockedMerchants, ...(input.blockedMerchants ?? [])])],
    requireApproval: true,
    autoApproveBelow: Math.min(serverPolicy.autoApproveBelow, input.autoApproveBelow ?? serverPolicy.autoApproveBelow)
  });
  try {
    parseMajorToMinor(resolved.maxTransactionAmount, currency);
    parseMajorToMinor(resolved.maxItemPrice, currency);
    parseMajorToMinor(resolved.autoApproveBelow, currency);
  } catch (error) {
    if (error instanceof MoneyError) throw new InvalidUserPolicyError();
    throw error;
  }
  return resolved;
}
