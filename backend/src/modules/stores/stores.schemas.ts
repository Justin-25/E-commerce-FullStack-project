import { z } from "zod";

export const storeSlugSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/, { error: "Store not found" }) });
