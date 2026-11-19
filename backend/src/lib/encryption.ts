import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets stored in the database (2FA secrets now; tax IDs and
 * payout account numbers later) with AES-256-GCM, which also detects any
 * tampering. A stolen database copy alone reveals nothing.
 *
 * Stored format: "v1.<iv>.<ciphertext>.<tag>" (base64url). The "v1" leaves
 * room to rotate to a new key later without breaking existing values.
 * `context` (e.g. the user id) is bound to the value: a secret copied into
 * another user's row fails to decrypt.
 */
export interface FieldCipher {
  encrypt(plaintext: string, context: string): string;
  decrypt(stored: string, context: string): string;
}

export function createFieldCipher(keyBase64Url: string): FieldCipher {
  // Derive exactly 32 bytes for AES-256 from the configured key, for this one purpose.
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(keyBase64Url, "base64url"), Buffer.alloc(0), "vendora field encryption v1", 32));

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(12); // a fresh nonce for every value, as GCM requires
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv, ciphertext, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
    },
    decrypt(stored, context) {
      const [version, iv, ciphertext, tag] = stored.split(".");
      if (version !== "v1" || !iv || !ciphertext || !tag) throw new Error("unknown encrypted value format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    }
  };
}
