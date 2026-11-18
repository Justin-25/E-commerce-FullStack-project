import type { AccessClaims } from "../modules/auth/tokens.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware when the access pass is valid. */
      auth?: AccessClaims;
    }
  }
}

export {};
