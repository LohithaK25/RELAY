import { Type } from "@google/genai";

export const shoppingIntentResponseSchema = {
  type: Type.OBJECT,
  properties: {
    originalRequest: { type: Type.STRING },
    category: { type: Type.STRING, nullable: true },
    productType: { type: Type.STRING, nullable: true },
    budget: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        amount: { type: Type.NUMBER },
        currency: { type: Type.STRING }
      },
      required: ["amount", "currency"],
      propertyOrdering: ["amount", "currency"]
    },
    requiredAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
    preferredAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
    excludedAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
    deliveryRequirement: { type: Type.STRING, nullable: true },
    quantity: { type: Type.INTEGER },
    location: { type: Type.STRING, nullable: true },
    country: { type: Type.STRING, nullable: true },
    additionalPreferences: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: [
    "originalRequest",
    "category",
    "productType",
    "budget",
    "requiredAttributes",
    "preferredAttributes",
    "excludedAttributes",
    "deliveryRequirement",
    "quantity",
    "location",
    "country",
    "additionalPreferences"
  ],
  propertyOrdering: [
    "originalRequest",
    "category",
    "productType",
    "budget",
    "requiredAttributes",
    "preferredAttributes",
    "excludedAttributes",
    "deliveryRequirement",
    "quantity",
    "location",
    "country",
    "additionalPreferences"
  ]
};
