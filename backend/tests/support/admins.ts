import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { AdminRole } from "../../src/modules/admin/access.js";
import { makeAdmin } from "../../src/modules/admin/accounts.js";
import { totpCode } from "./authHarness.js";
import type { Browser } from "./browser.js";
import type { CatalogHarness } from "./catalogHarness.js";

/** Admin steps for tests: an admin made the way `npm run admin:create` does, and "Confirm it's you". */
export function admins(h: CatalogHarness) {
  /** A signed-in admin with these roles (two-step verification on unless `twoFactor: false`). */
  async function admin(roles: AdminRole[] = ["SUPPORT"], { twoFactor = true, name = "Ops Admin" }: { twoFactor?: boolean; name?: string } = {}) {
    const s = await h.signUp({ email: `admin-${randomUUID().slice(0, 8)}@example.com`, name });
    const manualKey = twoFactor ? (await h.enableTwoFactor(s.browser)).manualKey : "";
    expect(await makeAdmin(h.db.prisma, s.user.email, roles)).toBe("made_admin");
    return { ...s, manualKey };
  }

  /** "Confirm it's you" with the authenticator app (valid 10 minutes on this browser). */
  async function confirm(who: { browser: Browser; user: { id: string }; manualKey: string }) {
    await h.allowCodeReuse(who.user.id);
    expect((await who.browser.post("/api/v1/auth/confirm", { code: totpCode(who.manualKey) })).status).toBe(200);
  }

  return { admin, confirm };
}
