import type { Response } from "express";

/**
 * Public pages (same answer for everyone): browsers and CDNs may keep them briefly.
 * Prices and stock change, hence 60 seconds by default.
 */
export const publicCache = (res: Response, seconds = 60) => res.set("Cache-Control", `public, max-age=${seconds}`);

/** Answers about the signed-in person: never stored by browsers or shared caches. */
export const privateNoStore = (res: Response) => res.set("Cache-Control", "private, no-store");
