import { Router } from "express";
import { privateNoStore } from "../../lib/httpCache.js";
import { signedInUserId, type AuthGuards } from "../../middleware/auth.js";
import { addressCreateSchema, addressIdSchema, addressUpdateSchema } from "./addresses.schemas.js";
import type { AddressService } from "./addresses.service.js";

/** The signed-in shopper's saved addresses. Never cached; changes are CSRF-checked app-wide. */
export function addressesRouter({ addresses, guards }: { addresses: AddressService; guards: AuthGuards }): Router {
  const router = Router();
  router.use("/addresses", ...guards.requireAuth, (_req, res, next) => {
    privateNoStore(res);
    next();
  });

  router.get("/addresses", async (req, res) => {
    res.json({ addresses: await addresses.list(signedInUserId(req)) });
  });

  router.post("/addresses", async (req, res) => {
    const address = await addresses.create(signedInUserId(req), addressCreateSchema.parse(req.body));
    res.status(201).json({ address });
  });

  router.put("/addresses/:id", async (req, res) => {
    const { id } = addressIdSchema.parse(req.params);
    res.json({ address: await addresses.update(signedInUserId(req), id, addressUpdateSchema.parse(req.body)) });
  });

  router.delete("/addresses/:id", async (req, res) => {
    await addresses.remove(signedInUserId(req), addressIdSchema.parse(req.params).id);
    res.json({ deleted: true });
  });

  router.post("/addresses/:id/default", async (req, res) => {
    res.json({ address: await addresses.setDefault(signedInUserId(req), addressIdSchema.parse(req.params).id) });
  });

  return router;
}
