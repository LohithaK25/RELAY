export function buildIntentPrompt(request: string): string {
  return [
    "Extract a shopping intent from the user's request.",
    "Return only the JSON matching the provided schema.",
    "Do not infer a country, location, currency, budget, quantity, or constraint that the user did not state.",
    "Use null for unknown optional scalar fields and empty arrays for absent attribute lists.",
    "Represent explicitly stated currency using its ISO 4217 code. Convert stated shorthand amounts to their numeric value.",
    "Separate must-have requirements, preferences, and exclusions accurately.",
    "Put broad product-use descriptions such as 'development laptop' or 'gaming laptop' in productType/category context, not requiredAttributes. Reserve requiredAttributes for explicit, verifiable specifications such as '32GB RAM'.",
    "",
    "User request:",
    request
  ].join("\n");
}
