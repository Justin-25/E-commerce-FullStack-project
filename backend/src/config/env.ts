import { existsSync } from "node:fs";
import { z } from "zod";

// Empty values in .env (e.g. "DATABASE_URL=") mean "not set".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    JSON_BODY_LIMIT: z.string().regex(/^\d{1,4}(kb|mb)$/, "use a size like 10kb").default("10kb"),
    DATABASE_URL: optional(z.url()),
    REDIS_URL: optional(z.url())
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const key of ["DATABASE_URL", "REDIS_URL"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
    }
    if (env.CORS_ORIGINS.some((o) => !o.startsWith("https://"))) {
      ctx.addIssue({ code: "custom", path: ["CORS_ORIGINS"], message: "must use https:// origins in production" });
    }
  });

export type Config = z.infer<typeof schema>;

/**
 * Validates environment variables once at startup. Fails fast with a list of
 * the problems — it names the variables but never prints their values (secrets).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Loads backend/.env into process.env if it exists (real env vars win). */
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
