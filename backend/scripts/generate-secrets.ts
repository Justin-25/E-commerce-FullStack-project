/**
 * Creates the secret keys in backend/.env: only the ones that are missing or
 * empty, so running it again never changes existing keys (changing them would
 * sign everyone out). The values are never printed.
 *
 *   npm run secrets
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SECRET_KEYS } from "../src/config/env.js";

const ENV_FILE = ".env";

if (!existsSync(ENV_FILE)) {
  copyFileSync(".env.example", ENV_FILE);
  console.log("Created .env from .env.example");
}

let text = readFileSync(ENV_FILE, "utf8");
const added: string[] = [];
for (const key of SECRET_KEYS) {
  const line = new RegExp(`^${key}=(.*)$`, "m");
  const current = line.exec(text)?.[1]?.trim();
  if (current) continue;
  const value = randomBytes(32).toString("base64url"); // 256 random bits
  text = current === undefined ? `${text.replace(/\s*$/, "")}\n${key}=${value}\n` : text.replace(line, `${key}=${value}`);
  added.push(key);
}
writeFileSync(ENV_FILE, text);
console.log(added.length ? `Added ${added.join(", ")} to .env (values not shown).` : "All secret keys already exist in .env; nothing changed.");
