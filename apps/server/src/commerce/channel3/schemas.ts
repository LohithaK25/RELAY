import { z } from "zod";

const channel3PriceSchema = z.object({
  price: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/)
}).passthrough();

const channel3OfferSchema = z.object({
  url: z.string().url(),
  domain: z.string().min(1),
  price: channel3PriceSchema,
  availability: z.enum(["InStock", "OutOfStock"])
}).passthrough();

export const channel3ProductSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  images: z.array(z.object({
    url: z.string().url(),
    cleaned_url: z.string().url().nullable().optional(),
    is_main_image: z.boolean().optional(),
    alt_text: z.string().nullable().optional()
  }).passthrough()).optional(),
  category: z.object({
    title: z.string().optional(),
    slug: z.string().optional()
  }).passthrough().nullable().optional(),
  brands: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  materials: z.array(z.string()).nullable().optional(),
  key_features: z.array(z.string()).nullable().optional(),
  structured_attributes: z.record(z.string(), z.array(z.string())).optional(),
  offers: z.array(channel3OfferSchema).optional()
}).passthrough();

export const channel3SearchResponseSchema = z.object({
  products: z.array(channel3ProductSchema)
}).passthrough();

export type Channel3Product = z.infer<typeof channel3ProductSchema>;
