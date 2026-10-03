import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

import { loginRateLimit } from "./loginRateLimit.js";

// Die Bremse vor den beiden Login-Routen ist der einzige Schutz gegen das
// Durchprobieren einer 4-stelligen PIN (10 000 Kombinationen – ohne Limit in
// Minuten geraten). Getestet wird deshalb beides: dass sie greift, und dass sie
// den normalen Betrieb nicht behindert (verlesene PIN, mehrere Geräte).
//
// Die Zähler liegen in einer modulweiten Map (bewusst, In-Memory pro Instanz).
// Jeder Test benutzt daher eine EIGENE IP, statt das Modul zurückzusetzen – so
// bleiben die Fälle unabhängig, ohne den Cache-Mechanismus zu umgehen.
const MAX_ATTEMPTS = 10;

function reqFrom(ip: string) {
  return { ip } as unknown as FastifyRequest;
}

function replyStub() {
  const headers: Record<string, string> = {};
  const reply = {
    header: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return reply;
    }),
  };
  return { reply: reply as unknown as FastifyReply, headers };
}

/** Fängt den geworfenen Fehler ein und gibt ihn zurück (null = durchgelassen). */
async function attempt(ip: string, reply: FastifyReply): Promise<(Error & { statusCode?: number }) | null> {
  try {
    await loginRateLimit(reqFrom(ip), reply);
    return null;
  } catch (err) {
    return err as Error & { statusCode?: number };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("loginRateLimit", () => {
  // Der Vertrag mit Fastify: ein preHandler MUSS ein Promise zurückgeben oder
  // done() rufen. Eine synchrone Funktion ohne beides lässt jeden Login-Request
  // hängen – der Fehler wäre im Betrieb ein Totalausfall der Anmeldung und im
  // Code nicht zu sehen. Deshalb hier festgenagelt.
  it("gibt ein Promise zurück (sonst hängt der Request)", () => {
    const { reply } = replyStub();

    const result = loginRateLimit(reqFrom("ip-promise"), reply);

    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it("lässt die ersten 10 Versuche durch", async () => {
    const { reply } = replyStub();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await attempt("ip-erlaubt", reply)).toBeNull();
    }
  });

  it("blockt den 11. Versuch mit 429", async () => {
    const { reply } = replyStub();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await attempt("ip-block", reply);

    const err = await attempt("ip-block", reply);

    expect(err?.statusCode).toBe(429);
  });

  // Ohne Retry-After weiß der Client nicht, wann er es wieder versuchen darf.
  it("nennt im Retry-After die verbleibenden Sekunden des Fensters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00Z"));
    const { reply, headers } = replyStub();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await attempt("ip-retry", reply);

    // 20 s ins Fenster hinein → es bleiben 40 s.
    vi.setSystemTime(new Date("2026-08-23T10:00:20Z"));
    await attempt("ip-retry", reply);

    expect(headers["Retry-After"]).toBe("40");
  });

  // Ein Angreifer darf nicht die Anmeldung des ganzen Lagers lahmlegen, indem
  // er das Limit vollmacht.
  it("zählt je IP getrennt", async () => {
    const { reply } = replyStub();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await attempt("ip-angreifer", reply);

    expect(await attempt("ip-unbeteiligt", reply)).toBeNull();
  });

  it("lässt nach Ablauf des Fensters wieder zu", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00Z"));
    const { reply } = replyStub();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await attempt("ip-fenster", reply);
    expect((await attempt("ip-fenster", reply))?.statusCode).toBe(429);

    // Fenster ist eine Minute – danach beginnt ein neues.
    vi.setSystemTime(new Date("2026-08-23T10:01:01Z"));

    expect(await attempt("ip-fenster", reply)).toBeNull();
  });

  // Das neue Fenster startet bei 1, nicht bei 0 – sonst hätte eine IP nach
  // jedem Ablauf einen Gratis-Versuch mehr.
  it("beginnt das neue Fenster mit dem laufenden Versuch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00Z"));
    const { reply } = replyStub();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await attempt("ip-neustart", reply);

    vi.setSystemTime(new Date("2026-08-23T10:01:01Z"));
    // Erster Versuch im neuen Fenster …
    expect(await attempt("ip-neustart", reply)).toBeNull();
    // … danach bleiben genau MAX_ATTEMPTS - 1 weitere.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      expect(await attempt("ip-neustart", reply)).toBeNull();
    }

    expect((await attempt("ip-neustart", reply))?.statusCode).toBe(429);
  });
});
