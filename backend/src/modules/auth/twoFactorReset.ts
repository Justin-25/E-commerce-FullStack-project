import { hmacHex } from "../../lib/crypto.js";

/** "Reset two-step verification" (7c): the owner's link works this long. */
export const TWO_FACTOR_RESET_TTL_SECONDS = 24 * 60 * 60;

/** Only a keyed hash of the link's token is stored (like password-reset links), so a database copy can't be turned into working links. */
export const twoFactorResetHash = (hashKey: string, token: string) => hmacHex(hashKey, `link:TWO_FACTOR_RESET:${token}`);
