/**
 * Tests gegen eine ECHTE PostgreSQL: Kapazitaetspruefung und Doppel-Zuweisung
 * in `activateOnStep` (routes/assignments.ts).
 *
 * Warum dieser Test eine ECHTE Datenbank braucht: die Regel gegen
 * Doppelbelegung haengt an einer PostgreSQL-Zeilensperre
 * (`SELECT id FROM "Step" ... FOR UPDATE`). Sperren sind Verhalten des
 * Servers, kein Rueckgabewert – gegen ein gemocktes Prisma waere der Test
 * gruen, egal ob die Sperre da ist oder nicht. Genau deshalb blieb er
 * monatelang ungeschrieben.
 *
 * Vorbereitung einmalig:  npm run db:test:setup
 * Ohne erreichbare Test-Datenbank ueberspringt sich die Datei selbst,
 * damit ein Lauf ohne PostgreSQL nicht rot wird.
 */
// MUSS als erster Import stehen – biegt DATABASE_URL auf die Test-Datenbank um,
// bevor db.ts den PrismaClient baut.
import "../testEnv.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { buildServer } from "../server.js";

let app: FastifyInstance;
let reachable = false;

/**
 * Test, der sich selbst ueberspringt, wenn keine Test-Datenbank da ist.
 * (Kein `describe.skip`: ob die Datenbank antwortet, steht erst nach einer
 * Abfrage fest – und Top-Level-`await` ist in dieser Modulkonfiguration nicht
 * erlaubt. Die Pruefung passiert deshalb in beforeAll.)
 */
const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() wirft – der Rest des Tests laeuft danach nicht mehr.
    if (!reachable) ctx.skip();
    await fn();
  });

async function truncateAll() {
  // Tabellenliste aus dem Katalog statt fest verdrahtet: kommt ein Modell dazu,
  // raeumt der Test es automatisch mit ab. _prisma_migrations bleibt stehen,
  // sonst waere die Datenbank danach "unmigriert".
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Aufgabe mit genau einem Schritt plus qualifizierte, anwesende Mitarbeiter. */
async function seed({ count, minWorkers, maxWorkers }: {
  count: number;
  minWorkers?: number | null;
  maxWorkers: number | null;
}) {
  const skill = await prisma.skill.create({ data: { name: "Kommissionieren" } });
  const task = await prisma.task.create({ data: { name: "Testaufgabe", poolEnabled: true } });
  const step = await prisma.step.create({
    data: {
      taskId: task.id,
      skillId: skill.id,
      name: skill.name,
      orderIndex: 0,
      minWorkers: minWorkers ?? null,
      maxWorkers,
      availableAt: new Date(),
    },
  });
  const employees = [];
  for (let i = 0; i < count; i++) {
    employees.push(
      await prisma.employee.create({
        data: {
          name: `MA ${i + 1}`,
          // PIN ist @db.Char(4) und eindeutig – vierstellig ab 1000 hochzaehlen.
          pin: String(1000 + i),
          present: true,
          skills: { create: { skillId: skill.id } },
        },
      }),
    );
  }
  return { skill, task, step, employees };
}

const login = (employeeId: string, stepId: string) =>
  app.inject({
    method: "POST",
    url: "/api/assignments",
    headers: {
      authorization: `Bearer ${app.jwt.sign({ sub: employeeId, role: "WORKER", name: "MA" })}`,
    },
    payload: { stepId },
  });

const activeCount = (stepId: string) =>
  prisma.assignment.count({ where: { stepId, state: "ACTIVE" } });

// Hooks auf DATEIebene, nicht in einem describe: sie gelten sonst nur fuer den
// einen Block, und der zweite liefe ohne Aufraeumen gegen Reste des ersten.
beforeAll(async () => {
  try {
    // Zweite Abfrage bewusst gegen eine echte Tabelle: eine erreichbare, aber
    // nicht migrierte Datenbank soll ebenfalls als "nicht bereit" gelten.
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$queryRaw`SELECT 1 FROM "Step" LIMIT 1`;
    reachable = true;
  } catch {
    console.warn(
      "[db-test] Test-Datenbank nicht bereit – Tests uebersprungen. Vorbereiten: npm run db:test:setup",
    );
    return;
  }
  app = buildServer();
  await app.ready();

  // Verbindungspool aufwaermen. Ohne das laeuft der ERSTE Test gegen einen
  // kalten Pool: die Verbindungen werden nacheinander aufgebaut, die Anfragen
  // serialisieren sich dadurch von allein und der Test ist auch OHNE die
  // Zeilensperre gruen – also kein Nachweis. Nachgewiesen per Gegenprobe
  // (Sperre auskommentiert): mit Aufwaermen faellt er, ohne nicht.
  await Promise.all(Array.from({ length: 10 }, () => prisma.$queryRaw`SELECT 1`));
});
afterAll(async () => {
  if (app) await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (reachable) await truncateAll();
});

describe("Gleichzeitiges Einloggen auf denselben Schritt", () => {

  dbIt("laesst bei einem Einzel-Platz genau einen von fuenf durch", async () => {
    const { step, employees } = await seed({ count: 5, maxWorkers: 1 });

    const res = await Promise.all(employees.map((e) => login(e.id, step.id)));
    const codes = res.map((r) => r.statusCode).sort();

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(4);
    // Der eigentliche Punkt: die Datenbank darf nicht ueberbucht sein.
    expect(await activeCount(step.id)).toBe(1);
  });

  dbIt("fuellt drei Plaetze mit genau drei von acht", async () => {
    const { step, employees } = await seed({ count: 8, maxWorkers: 3 });

    const res = await Promise.all(employees.map((e) => login(e.id, step.id)));
    const codes = res.map((r) => r.statusCode);

    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    expect(await activeCount(step.id)).toBe(3);
  });

  dbIt("nennt im Fehlertext die tatsaechliche Belegung", async () => {
    const { step, employees } = await seed({ count: 3, maxWorkers: 1 });
    const res = await Promise.all(employees.map((e) => login(e.id, step.id)));

    const abgewiesen = res.filter((r) => r.statusCode === 409);
    expect(abgewiesen.length).toBeGreaterThan(0);
    for (const r of abgewiesen) {
      expect(JSON.parse(r.body).error).toMatch(/voll \(1\/1\)/);
    }
  });

  dbIt("startet den Team-Timer genau einmal, wenn die Mindestbesetzung gleichzeitig eintrifft", async () => {
    const { step, employees } = await seed({ count: 2, minWorkers: 2, maxWorkers: 2 });

    const res = await Promise.all(employees.map((e) => login(e.id, step.id)));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201]);

    const after = await prisma.step.findUniqueOrThrow({ where: { id: step.id } });
    expect(after.startedAt).not.toBeNull();
    expect(await activeCount(step.id)).toBe(2);
  });

  dbIt("laesst einen unbegrenzten Schritt (maxWorkers = null) alle durch", async () => {
    // Gegenprobe: die Sperre serialisiert, sie darf aber nichts abweisen,
    // wo es keine Obergrenze gibt – sonst waere der Test oben auch dann
    // gruen, wenn schlicht immer abgelehnt wird.
    const { step, employees } = await seed({ count: 4, maxWorkers: null });

    const res = await Promise.all(employees.map((e) => login(e.id, step.id)));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    expect(await activeCount(step.id)).toBe(4);
  });
});

describe("Derselbe Mitarbeiter mehrfach auf demselben Schritt", () => {
  dbIt("weist den zweiten Login auf denselben Schritt ab", async () => {
    const { step, employees } = await seed({ count: 1, maxWorkers: 3 });
    const [anna] = employees;

    expect((await login(anna.id, step.id)).statusCode).toBe(201);
    const zweiter = await login(anna.id, step.id);

    expect(zweiter.statusCode).toBe(409);
    expect(JSON.parse(zweiter.body).error).toMatch(/bereits eingesetzt/);
    expect(await activeCount(step.id)).toBe(1);
  });

  dbIt("laesst auch bei drei gleichzeitigen Versuchen nur einen durch", async () => {
    // Die Variante, die ohne die FOR-UPDATE-Sperre durchrutschen wuerde: die
    // Pruefung allein reicht nicht, sie muss unter der Sperre stattfinden.
    const { step, employees } = await seed({ count: 1, maxWorkers: 3 });
    const [anna] = employees;

    const res = await Promise.all([1, 2, 3].map(() => login(anna.id, step.id)));

    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect(await activeCount(step.id)).toBe(1);
  });

  dbIt("weist den Login ab, wenn schon eine unterbrochene Zuweisung besteht", async () => {
    // Der realistische Weg in den Fehler: unterbrechen und danach "Einloggen"
    // statt "Fortsetzen" druecken. Fuehrte zu PAUSED + ACTIVE auf einem Schritt
    // und beim Abschluss zu ZWEI WorkLog-Zeilen fuer eine Person.
    const { step, employees } = await seed({ count: 1, maxWorkers: 1 });
    const [anna] = employees;

    const erste = JSON.parse((await login(anna.id, step.id)).body);
    const pause = await app.inject({
      method: "POST",
      url: `/api/assignments/${erste.id}/pause`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: anna.id, role: "WORKER", name: "MA" })}` },
      payload: { reason: "SWITCH" },
    });
    expect(pause.statusCode).toBe(200);

    const erneut = await login(anna.id, step.id);
    expect(erneut.statusCode).toBe(409);
    expect(await prisma.assignment.count({ where: { stepId: step.id } })).toBe(1);
  });

  dbIt("laesst einen erneuten Login zu, wenn die alte Zuweisung erledigt ist", async () => {
    // DONE und REJECTED sind von der Regel bewusst ausgenommen – sonst koennte
    // ein MA einen Schritt nach Abschluss nie wieder uebernehmen.
    const { step, employees } = await seed({ count: 1, maxWorkers: 1 });
    const [anna] = employees;
    const heute = new Date();
    heute.setHours(0, 0, 0, 0);
    await prisma.assignment.create({
      data: { stepId: step.id, employeeId: anna.id, dayKey: heute, state: "DONE", finishedAt: new Date() },
    });

    expect((await login(anna.id, step.id)).statusCode).toBe(201);
    expect(await activeCount(step.id)).toBe(1);
  });

  dbIt("laesst das Annehmen des eigenen Angebots zu", async () => {
    // Regression: beim Annehmen ist das OFFERED-Angebot selbst eine Zuweisung
    // des MA auf diesem Schritt. Wird es nicht ausgenommen, wuerde die neue
    // Pruefung das Annehmen gegen sich selbst mit 409 abweisen.
    const { step, employees } = await seed({ count: 1, maxWorkers: 1 });
    const [anna] = employees;
    const heute = new Date();
    heute.setHours(0, 0, 0, 0);
    const angebot = await prisma.assignment.create({
      data: { stepId: step.id, employeeId: anna.id, dayKey: heute, state: "OFFERED" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/assignments/${angebot.id}/accept`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: anna.id, role: "WORKER", name: "MA" })}` },
    });

    expect(res.statusCode).toBe(200);
    expect(await activeCount(step.id)).toBe(1);
    expect(await prisma.assignment.count({ where: { stepId: step.id } })).toBe(1);
  });
});
