import { Router } from "express";
import { publicCache } from "../../lib/httpCache.js";
import type { HomeService } from "./home.service.js";

/** The Home page's data, the same for every visitor (personal rows come with the cart in milestone 5). */
export function homeRouter({ home }: { home: HomeService }): Router {
  const router = Router();

  router.get("/home", async (_req, res) => {
    const page = await home.home();
    publicCache(res);
    res.json(page);
  });

  return router;
}
