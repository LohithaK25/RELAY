import { randomUUID } from "node:crypto";
import { ProductSchema, ShoppingIntentSchema, type Product, type ShoppingIntent } from "@relay/shared";

export class ProductRepository {
  readonly instanceId = randomUUID();
  private readonly products = new Map<string, { product: Product; intent: ShoppingIntent }>();

  constructor() {
    if (process.env.NODE_ENV !== "production") {
      console.info("REPOSITORY_INSTANCE_CREATED", { instanceId: this.instanceId, processId: process.pid });
    }
  }

  save(products: Product[], intent: ShoppingIntent): void {
    for (const product of products) {
      const validated = ProductSchema.parse(product);
      this.products.set(validated.id, { product: validated, intent: ShoppingIntentSchema.parse(intent) });
      if (process.env.NODE_ENV !== "production") {
        console.info("PRODUCT_STORE", {
          instanceId: this.instanceId,
          productId: validated.id,
          repositorySize: this.products.size
        });
      }
    }
    if (process.env.NODE_ENV !== "production") {
      console.info("PRODUCT_STORE_SUMMARY", {
        instanceId: this.instanceId,
        storedCount: products.length,
        repositorySize: this.products.size
      });
    }
  }

  get(productId: string): Product | undefined {
    const record = this.products.get(productId);
    if (process.env.NODE_ENV !== "production") {
      console.info("PRODUCT_LOOKUP", {
        instanceId: this.instanceId,
        productId,
        found: Boolean(record),
        repositorySize: this.products.size
      });
    }
    return record ? ProductSchema.parse(record.product) : undefined;
  }

  getIntent(productId: string): ShoppingIntent | undefined {
    return this.products.get(productId)?.intent;
  }

  clear(): void {
    this.products.clear();
    if (process.env.NODE_ENV !== "production") {
      console.info("PRODUCT_REPOSITORY_CLEARED", {
        instanceId: this.instanceId,
        repositorySize: this.products.size
      });
    }
  }
}
