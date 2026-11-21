/** "Only 3 left" at or below this; exact stock is never shown above it. */
export const LOW_STOCK = 5;

export type StockStatus = { status: "in_stock" } | { status: "low_stock"; left: number } | { status: "out_of_stock" };

/** What shoppers see about stock, the same on the product page and in the cart. */
export function stockStatus(stock: number): StockStatus {
  if (stock <= 0) return { status: "out_of_stock" };
  return stock <= LOW_STOCK ? { status: "low_stock", left: stock } : { status: "in_stock" };
}
