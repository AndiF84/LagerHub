import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { authAny, authDashboard, authManager, authAdmin, type AuthRole } from "./auth.js";

// Mini-Fastify mit @fastify/jwt + je einer Route pro Schutzklasse. Testet die
// Guards über app.inject (kein echter Server nötig).
const SECRET = "test-secret";

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(jwt, { secret: SECRET });
  app.get("/any", { preHandler: [authAny] }, async () => ({ ok: true }));
  app.get("/dashboard", { preHandler: [authDashboard] }, async () => ({ ok: true }));
  app.get("/manager", { preHandler: [authManager] }, async () => ({ ok: true }));
  app.get("/admin", { preHandler: [authAdmin] }, async () => ({ ok: true }));
  return app;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

const token = (role: AuthRole) => app.jwt.sign({ sub: "x", role, name: "T" });
const get = (url: string, tok?: string) =>
  app.inject({ method: "GET", url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });

describe("Auth-Guards", () => {
  it("ohne Token → 401", async () => {
    expect((await get("/any")).statusCode).toBe(401);
    expect((await get("/admin")).statusCode).toBe(401);
  });

  it("ungültiges Token → 401", async () => {
    expect((await get("/any", "kaputt.kein.jwt")).statusCode).toBe(401);
  });

  it("authAny akzeptiert jede Rolle inkl. WORKER", async () => {
    for (const role of ["WORKER", "OFFICE", "MANAGER", "ADMIN"] as AuthRole[]) {
      expect((await get("/any", token(role))).statusCode).toBe(200);
    }
  });

  it("authDashboard: WORKER 403, OFFICE/MANAGER/ADMIN 200", async () => {
    expect((await get("/dashboard", token("WORKER"))).statusCode).toBe(403);
    expect((await get("/dashboard", token("OFFICE"))).statusCode).toBe(200);
    expect((await get("/dashboard", token("MANAGER"))).statusCode).toBe(200);
    expect((await get("/dashboard", token("ADMIN"))).statusCode).toBe(200);
  });

  it("authManager: OFFICE 403, MANAGER/ADMIN 200", async () => {
    expect((await get("/manager", token("OFFICE"))).statusCode).toBe(403);
    expect((await get("/manager", token("MANAGER"))).statusCode).toBe(200);
    expect((await get("/manager", token("ADMIN"))).statusCode).toBe(200);
  });

  it("authAdmin: nur ADMIN 200, MANAGER 403", async () => {
    expect((await get("/admin", token("MANAGER"))).statusCode).toBe(403);
    expect((await get("/admin", token("ADMIN"))).statusCode).toBe(200);
  });
});
