// Authentifizierung/Autorisierung der /api-Routen. Zustandsloses JWT (via
// @fastify/jwt, in server.ts registriert) im Authorization: Bearer-Header. Die
// Guards sind reine preHandler-Funktionen: sie verifizieren das Token
// (request.jwtVerify) und prüfen danach die Rolle. Kein DB-Zugriff, keine Session.
//
// Token-Nutzlast: { sub: employeeId | "admin", role, name }. Ausgestellt in
// employees.ts (/pin-login + /login). ADMIN hat bewusst keinen DB-Datensatz
// (geheime PIN) → sub = "admin".
import type { FastifyReply, FastifyRequest } from "fastify";

// Auth-Rollen = Prisma-Rollen (MANAGER/OFFICE/WORKER) PLUS ADMIN. ADMIN ist
// bewusst KEINE DB-/MA-Rolle (geheime PIN, kein Datensatz), taucht daher nicht im
// Prisma-Enum auf, existiert aber als Token-Rolle. Deckungsgleich mit dem Role-Typ
// der Frontends (`frontend/src/api/types.ts`).
export type AuthRole = "ADMIN" | "MANAGER" | "OFFICE" | "WORKER";

// Nutzlast + request.user typisieren (Module-Augmentation von @fastify/jwt).
export interface AuthPayload {
  sub: string;
  role: AuthRole;
  name: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

// Verifiziert das Token; ohne/ungültig → 401. Bei Erfolg steht request.user bereit.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Nicht angemeldet" });
  }
}

// Verifiziert das Token UND prüft die Rolle; falsche Rolle → 403.
function requireRole(...roles: AuthRole[]) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Nicht angemeldet" });
    }
    if (!roles.includes(req.user.role)) {
      reply.code(403).send({ error: "Keine Berechtigung" });
    }
  };
}

// Vordefinierte Schutzklassen (siehe Klassifikation im Auth-Plan):
//   authAny        – jedes gültige Token (inkl. WORKER); Self-Service/PWA
//   authDashboard  – OFFICE, MANAGER, ADMIN; Dashboard-Lese-/Aufgaben-Aktionen
//   authManager    – MANAGER, ADMIN; MA-/Skill-Verwaltung, Historie-Mutationen
//   authAdmin      – ADMIN; Statistik-Auswertungen
export const authAny = requireAuth;
export const authDashboard = requireRole("OFFICE", "MANAGER", "ADMIN");
export const authManager = requireRole("MANAGER", "ADMIN");
export const authAdmin = requireRole("ADMIN");
