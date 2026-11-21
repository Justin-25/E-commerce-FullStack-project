import type { Express } from "express";
import request from "supertest";

/**
 * A pretend browser: keeps cookies between requests (like a real one) and
 * sends the CSRF token on every POST, exactly as the frontend will.
 */
export class Browser {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken = "";
  /** Extra headers on every request, e.g. X-Forwarded-For to pretend to be on another network. */
  headers: Record<string, string> = {};

  constructor(app: Express) {
    this.agent = request.agent(app);
  }

  static async open(app: Express, headers: Record<string, string> = {}): Promise<Browser> {
    const browser = new Browser(app);
    browser.headers = headers;
    await browser.loadCsrfToken();
    return browser;
  }

  async loadCsrfToken() {
    const res = await this.agent.get("/api/v1/auth/csrf").set(this.headers);
    this.csrfToken = String(res.body.csrfToken);
    return res;
  }

  get(path: string) {
    return this.agent.get(path).set(this.headers);
  }

  async post(path: string, body: object = {}) {
    const res = await this.agent.post(path).set(this.headers).set("X-CSRF-Token", this.csrfToken).send(body);
    if (typeof res.body?.csrfToken === "string") this.csrfToken = res.body.csrfToken; // sign-in/out hand out a new one
    return res;
  }

  patch(path: string, body: object = {}) {
    return this.agent.patch(path).set(this.headers).set("X-CSRF-Token", this.csrfToken).send(body);
  }

  put(path: string, body: object = {}) {
    return this.agent.put(path).set(this.headers).set("X-CSRF-Token", this.csrfToken).send(body);
  }

  delete(path: string) {
    return this.agent.delete(path).set(this.headers).set("X-CSRF-Token", this.csrfToken);
  }
}

/** The Set-Cookie header for one cookie, e.g. "vd_rt=…; Path=/api/v1/auth; HttpOnly; SameSite=Strict". */
export function setCookie(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const all = res.headers["set-cookie"];
  const list = Array.isArray(all) ? (all as string[]) : [];
  return list.find((c) => c.startsWith(`${name}=`));
}

/** Just the value of a cookie set by this response. */
export function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const header = setCookie(res, name);
  return header ? decodeURIComponent(header.slice(name.length + 1).split(";")[0] ?? "") : undefined;
}
