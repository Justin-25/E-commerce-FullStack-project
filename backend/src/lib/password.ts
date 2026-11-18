import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { randomToken } from "./crypto.js";

const argon2Async = promisify(argon2);

/**
 * Argon2id settings: OWASP's recommended minimum (19 MiB memory, 2 passes, 1 lane).
 * Memory-hard: each guess needs 19 MiB, which makes cracking stolen hashes on
 * graphics cards slow and expensive. Raise these later; old hashes are upgraded
 * automatically at the next sign-in (see needsRehash).
 */
export const ARGON2 = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

// Standard PHC string format, readable by every Argon2 library:
// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>   (base64 without padding)
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{16,128})$/;
const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

/** Same text for "é" typed different ways (NIST recommends normalizing before hashing). */
const normalize = (password: string) => password.normalize("NFKC");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2Async("argon2id", { message: normalize(password), nonce: salt, ...ARGON2 });
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`;
}

function parse(stored: string) {
  const m = PHC.exec(stored);
  if (!m) return null;
  const [, memory, passes, parallelism, salt, hash] = m;
  return {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    salt: Buffer.from(salt ?? "", "base64"),
    hash: Buffer.from(hash ?? "", "base64")
  };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const p = parse(stored);
  if (!p) return false;
  const candidate = await argon2Async("argon2id", {
    message: normalize(password),
    nonce: p.salt,
    memory: p.memory,
    passes: p.passes,
    parallelism: p.parallelism,
    tagLength: p.hash.length
  });
  return timingSafeEqual(candidate, p.hash);
}

/** True if the hash was made with older settings and should be re-hashed after a successful sign-in. */
export function needsRehash(stored: string): boolean {
  const p = parse(stored);
  return !p || p.memory !== ARGON2.memory || p.passes !== ARGON2.passes || p.parallelism !== ARGON2.parallelism;
}

let dummy: Promise<string> | undefined;
/**
 * A hash of a random password, checked when the email has no account. Sign-in
 * then takes the same time either way, so timing can't reveal who has an account.
 */
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomToken()));
