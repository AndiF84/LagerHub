import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asNoteArray, makeNoteEntry, noteAuthorFromUser, type NoteEntry } from "../services/notes.js";
import { publish } from "../events.js";
import { crewmeisterConfigured, getWorkingMinutes, CrewmeisterError } from "../services/crewmeister.js";
import { authAdmin, authDashboard, authManager } from "../auth.js";
import { stepDurationMinutes } from "../services/journalDuration.js";

// YYYY-MM-DD in Server-Lokalzeit (gleiche Semantik wie der "heute"-Filter).
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Lokaler Tagesbereich [start, end) für ein "YYYY-MM-DD".
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// Zeitraum [gte, lt) aus optionalem from/to ("YYYY-MM-DD"). Default: letzte 7
// Tage (heute + 6 Vortage). Grenzen sind lokale Mitternacht (wie dayRange).
function rangeFromQuery(from?: string, to?: string): { gte: Date; lt: Date } {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const lt = to ? dayRange(to).end : new Date(todayStart.getTime());
  if (!to) lt.setDate(lt.getDate() + 1); // bis einschließlich heute

  let gte: Date;
  if (from) {
    gte = dayRange(from).start;
  } else {
    gte = new Date(todayStart.getTime());
    gte.setDate(gte.getDate() - 6);
  }
  return { gte, lt };
}

// Alle Lokaltage "YYYY-MM-DD" im Bereich [start, endExcl) aufzählen – damit
// Zeitreihen-Diagramme auch Tage ohne Aktivität (Wert 0) zeigen.
function enumerateDays(start: Date, endExcl: Date): string[] {
  const out: string[] = [];
  const d = new Date(start);
  while (d < endExcl) {
    out.push(localDayKey(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Snapshot-Form eines TaskRun.data. Zeit-Felder sind im JSON ISO-Strings.
type RunSnapshotAssignment = {
  employeeId?: string;
  startedAt?: string;
  finishedAt?: string | null;
  pausedMs?: number;
};
type RunSnapshotStep = {
  id?: string;
  name?: string;
  // Start des Schritt-Timers (Team: erst ab Mindestbesetzung). Erst seit der
  // Journal-Schrittdauer im Snapshot – ältere Läufe haben das Feld nicht.
  startedAt?: string | null;
  assignments?: RunSnapshotAssignment[];
  notes?: unknown;
};
type RunSnapshot = { steps?: RunSnapshotStep[] };

// Baut die Journal-DTOs (inkl. Schritt-Notizen + Teilnehmernamen) aus TaskRuns.
async function buildJournalEntries(
  runs: { id: string; taskName: string; startedAt: Date; finishedAt: Date; data: Prisma.JsonValue }[],
) {
  const stepsOf = (data: Prisma.JsonValue): RunSnapshotStep[] => (data as RunSnapshot)?.steps ?? [];

  const employeeIdsOf = (data: Prisma.JsonValue): string[] => {
    const ids = new Set<string>();
    for (const s of stepsOf(data)) for (const a of s.assignments ?? []) if (a.employeeId) ids.add(a.employeeId);
    return [...ids];
  };

  // Namen aller beteiligten MA in EINER Abfrage nachladen.
  const allIds = [...new Set(runs.flatMap((r) => employeeIdsOf(r.data)))];
  const employees = allIds.length
    ? await prisma.employee.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(employees.map((e) => [e.id, e.name]));

  return runs.map((r) => {
    // Schritte des Laufs mit ihrem (eingefrorenen) Notiz-Verlauf, der Dauer des
    // Schritts sowie den beteiligten MA und deren Zeiten (Netto = Brutto − Pausen).
    const steps = stepsOf(r.data).map((s) => ({
      id: s.id ?? "",
      name: s.name ?? "",
      // Zeit, die am Schritt gearbeitet wurde – Team-Zeit zählt einmal,
      // Unterbrechungen nicht (Regeln in services/journalDuration.ts).
      durationMinutes: stepDurationMinutes(s.assignments ?? [], s.startedAt),
      notes: asNoteArray(s.notes),
      workers: (s.assignments ?? []).map((a) => {
        const start = a.startedAt ? new Date(a.startedAt).getTime() : null;
        const end = a.finishedAt ? new Date(a.finishedAt).getTime() : null;
        const pausedMs = a.pausedMs ?? 0;
        const netMs = start != null && end != null ? Math.max(0, end - start - pausedMs) : null;
        return {
          employeeId: a.employeeId ?? "",
          name: a.employeeId ? nameById.get(a.employeeId) ?? "—" : "—",
          activeMinutes: netMs != null ? Math.round(netMs / 60000) : null,
          pausedMinutes: Math.round(pausedMs / 60000),
        };
      }),
    }));
    return {
      id: r.id,
      taskName: r.taskName,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      // Gesamtzeit = Summe der (gerundeten) Schritt-Dauern – damit die Zahl im
      // zugeklappten Journal genau aufgeht, wenn man die Schritte aufklappt.
      // Bewusst NICHT die Wanduhr (Ende − Start): die zählte Liegezeiten
      // zwischen den Schritten und Unterbrechungen über Nacht mit.
      durationMinutes: steps.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0),
      participants: employeeIdsOf(r.data).map((id) => nameById.get(id) ?? "—"),
      steps,
    };
  });
}

export const statsRoutes: FastifyPluginAsync = async (app) => {
  // KPIs für heute (Statistik-Tab = ADMIN)
  app.get("/", { preHandler: [authAdmin] }, async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [activeEmployees, poolTasks, runs] = await Promise.all([
      prisma.assignment.findMany({
        where: { state: "ACTIVE" },
        distinct: ["employeeId"],
        select: { employeeId: true },
      }),
      prisma.task.count({ where: { poolEnabled: true, status: { not: "COMPLETED" }, deletedAt: null } }),
      prisma.taskRun.findMany({ where: { finishedAt: { gte: todayStart } } }),
    ]);

    const avgDurationMs =
      runs.length > 0
        ? runs.reduce((sum, r) => sum + (r.finishedAt.getTime() - r.startedAt.getTime()), 0) / runs.length
        : null;

    // Heute erledigte Arbeitsschritte = Summe der Schritte aller heute
    // abgeschlossenen Läufe (aus den TaskRun-Snapshots). Die Anzahl der
    // abgeschlossenen Durchläufe steht separat in /tasks-by-status.
    const stepsCompletedToday = runs.reduce(
      (sum, r) => sum + (((r.data as RunSnapshot)?.steps?.length) ?? 0),
      0,
    );

    return {
      stepsCompletedToday,
      activeEmployees: activeEmployees.length,
      poolTasksOpen: poolTasks,
      avgDurationMinutes: avgDurationMs ? Math.round(avgDurationMs / 60000) : null,
    };
  });

  // Aufgaben nach Status. "completed" = heute abgeschlossene Durchläufe (aus
  // TaskRun), NICHT Task.status=COMPLETED: finalizeTask setzt Aufgaben auf OPEN
  // zurück, der Status-Zähler stünde sonst fast immer auf 0.
  app.get("/tasks-by-status", { preHandler: [authAdmin] }, async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [open, running, completed] = await Promise.all([
      prisma.task.count({ where: { status: "OPEN", deletedAt: null } }),
      prisma.task.count({ where: { status: "RUNNING", deletedAt: null } }),
      prisma.taskRun.count({ where: { finishedAt: { gte: todayStart } } }),
    ]);
    return { open, running, completed };
  });

  // Mitarbeiter-Auslastung heute: Live-Übersicht "wer macht gerade was" +
  // heutige Netto-Gesamtzeit. Je MA: aktuell aktive Aufgabe/Schritt (falls
  // gerade ACTIVE), Zeit auf dieser Zuweisung und gesamte aktive Zeit heute.
  // Quellen: (1) heutige WorkLogs = bereits ABGESCHLOSSENE Arbeit (deren
  // Live-Zuweisungen bei finalizeTask gelöscht wurden) und (2) die noch
  // bestehenden Live-Zuweisungen. Keine Überschneidung je Arbeitseinheit:
  // erledigte Läufe stehen nur im WorkLog, laufende nur in Assignment.
  app.get("/employee-load", { preHandler: [authAdmin] }, async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [assignments, workLogs] = await Promise.all([
      prisma.assignment.findMany({
        where: { startedAt: { gte: todayStart } },
        include: {
          employee: { select: { id: true, name: true } },
          step: { select: { name: true, task: { select: { name: true } } } },
        },
      }),
      prisma.workLog.findMany({
        where: { finishedAt: { gte: todayStart } },
        include: { employee: { select: { id: true, name: true } } },
      }),
    ]);

    const now = new Date();
    // Damit die Uhr im Frontend mitlaufen kann, liefern wir Bezugspunkte statt
    // fertiger Minuten: `since` = pausenbereinigter Start der laufenden Zuweisung
    // (elapsed = now − since), `activeBaseMs` = heutige Netto-Zeit OHNE die
    // laufende Zuweisung (die tickt das Frontend live obendrauf).
    type Current = { taskName: string; stepName: string; since: Date };
    const byEmployee = new Map<
      string,
      { name: string; activeBaseMs: number; current: Current | null }
    >();
    const entryFor = (id: string, name: string) => {
      const e = byEmployee.get(id) ?? { name, activeBaseMs: 0, current: null };
      byEmployee.set(id, e);
      return e;
    };

    // (1) Bereits heute abgeschlossene Arbeit (fixe Netto-Zeit aus WorkLog).
    for (const w of workLogs) {
      entryFor(w.employeeId, w.employee.name).activeBaseMs += w.activeMs;
    }

    // (2) Noch bestehende Live-Zuweisungen.
    for (const a of assignments) {
      const entry = entryFor(a.employeeId, a.employee.name);
      // Aktuell bearbeitete Zuweisung (ACTIVE = arbeitet gerade). Pro MA gibt es
      // durch die Wechsel-Logik höchstens eine ACTIVE-Zuweisung; ihr Beitrag
      // wird NICHT in die Basis gezählt, sondern vorne live hochgezählt.
      if (a.state === "ACTIVE") {
        entry.current = {
          taskName: a.step.task.name,
          stepName: a.step.name,
          since: new Date(a.startedAt.getTime() + a.pausedMs),
        };
      } else {
        // Pausierte/erledigte Zuweisung eines noch laufenden Laufs: fixer
        // Netto-Beitrag (nie negativ).
        const end = a.finishedAt ?? now;
        const pausedMs = a.pausedMs + (a.pausedAt ? now.getTime() - a.pausedAt.getTime() : 0);
        entry.activeBaseMs += Math.max(0, end.getTime() - a.startedAt.getTime() - pausedMs);
      }
    }

    return Array.from(byEmployee.entries())
      .map(([id, v]) => ({
        employeeId: id,
        name: v.name,
        currentTask: v.current?.taskName ?? null,
        currentStep: v.current?.stepName ?? null,
        currentSince: v.current ? v.current.since.toISOString() : null,
        activeBaseMs: Math.round(v.activeBaseMs),
      }))
      // Gerade Aktive zuerst, dann nach Name.
      .sort((a, b) =>
        a.currentTask && !b.currentTask
          ? -1
          : !a.currentTask && b.currentTask
            ? 1
            : a.name.localeCompare(b.name),
      );
  });

  // Tagesjournal: abgeschlossene Durchläufe (aus TaskRun = Historie). Ohne
  // ?date = heute (fürs Dashboard); mit ?date=YYYY-MM-DD = ein bestimmter Tag
  // (für die Historie unter Statistik). Jeder Eintrag enthält den Notiz-Verlauf
  // seiner Schritte.
  // Tagesjournal: Dashboard-PoolTab + Historie-Tab (OFFICE/MANAGER/ADMIN).
  app.get("/journal", { preHandler: [authDashboard] }, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);

    let where: Prisma.TaskRunWhereInput;
    if (date) {
      const { start, end } = dayRange(date);
      where = { finishedAt: { gte: start, lt: end } };
    } else {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      where = { finishedAt: { gte: todayStart } };
    }

    const runs = await prisma.taskRun.findMany({ where, orderBy: { finishedAt: "desc" } });
    return buildJournalEntries(runs);
  });

  // Erinnerungs-Entscheidungen eines Tages (Erledigt / Verschoben / Pool /
  // Hinfällig) – gehören ins Tagesjournal, sind aber KEIN Arbeits-Durchlauf.
  // Deshalb ein eigener Endpunkt statt einer Erweiterung von /journal: die
  // TaskRun-DTOs bleiben unangetastet, und niemand verwechselt eine abgehakte
  // Erinnerung mit geleisteter Arbeit (Statistik/WorkLog zählen sie nicht mit).
  app.get("/journal/reminders", { preHandler: [authDashboard] }, async (req) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);

    let where: Prisma.ReminderEventWhereInput;
    if (date) {
      const { start, end } = dayRange(date);
      where = { decidedAt: { gte: start, lt: end } };
    } else {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      where = { decidedAt: { gte: todayStart } };
    }

    return prisma.reminderEvent.findMany({ where, orderBy: { decidedAt: "desc" } });
  });

  // Verfügbare Journal-Tage (Datum + Anzahl), absteigend. Gruppierung nach
  // Server-Lokaltag in JS (gleiche Semantik wie der "heute"-Filter); nur die
  // finishedAt-Spalte wird geladen.
  app.get("/journal/days", { preHandler: [authDashboard] }, async () => {
    // Vereinigung aus Arbeits-Durchläufen UND Erinnerungs-Entscheidungen: ein
    // Tag, an dem nur eine Erinnerung abgehakt wurde, hat trotzdem ein Journal
    // und darf in der Historie nicht fehlen.
    const [runs, events] = await Promise.all([
      prisma.taskRun.findMany({ select: { finishedAt: true } }),
      prisma.reminderEvent.findMany({ select: { decidedAt: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const r of runs) {
      const key = localDayKey(r.finishedAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const e of events) {
      const key = localDayKey(e.decidedAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  });

  // Admin trägt eine Notiz in der Historie nach (an einen Schritt eines Laufs).
  // Bewusste Abweichung vom "unveränderlichen Snapshot": append-only an
  // TaskRun.data.steps[].notes; Autor = der angemeldete Benutzer (Name aus dem Token).
  app.post("/journal/:runId/notes", { preHandler: [authManager] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { stepId, text } = z
      .object({ stepId: z.string().min(1), text: z.string().min(1).max(2000) })
      .parse(req.body);

    const run = await prisma.taskRun.findUnique({ where: { id: runId } });
    if (!run) return reply.status(404).send({ error: "Durchlauf nicht gefunden" });

    const data = (run.data as RunSnapshot) ?? {};
    const steps = data.steps ?? [];
    const target = steps.find((s) => s.id === stepId);
    if (!target) return reply.status(404).send({ error: "Schritt im Durchlauf nicht gefunden" });

    const notes: NoteEntry[] = asNoteArray(target.notes);
    const { authorType, authorName } = noteAuthorFromUser(req.user);
    notes.push(makeNoteEntry(text, authorType, authorName));
    target.notes = notes;

    await prisma.taskRun.update({
      where: { id: runId },
      data: { data: data as unknown as Prisma.InputJsonValue },
    });

    publish("lagerhub", { type: "JOURNAL_UPDATED", runId });
    return buildJournalEntries([{ ...run, data: data as Prisma.JsonValue }]).then((e) => e[0]);
  });

  // Ein ganzes Tagesjournal löschen (Hard-Delete aller TaskRuns des Tages).
  // Nur Vergangenheit – der laufende Tag bleibt geschützt.
  app.delete("/journal/:date", { preHandler: [authManager] }, async (req, reply) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.params);
    const { start, end } = dayRange(date);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (start >= todayStart) {
      return reply.status(400).send({ error: "Nur vergangene Tagesjournale können gelöscht werden" });
    }

    // Der Tag verschwindet ganz – auch die Erinnerungs-Entscheidungen, die
    // sonst als Rest ohne Journal zurückblieben.
    const [runs, events] = await prisma.$transaction([
      prisma.taskRun.deleteMany({ where: { finishedAt: { gte: start, lt: end } } }),
      prisma.reminderEvent.deleteMany({ where: { decidedAt: { gte: start, lt: end } } }),
    ]);
    publish("lagerhub", { type: "JOURNAL_DELETED", date });
    return { deleted: runs.count + events.count };
  });

  // Historische Auswertungen aus TaskRun (Statistik-Tab = ADMIN)
  app.get("/history", { preHandler: [authAdmin] }, async () => {
    const runs = await prisma.taskRun.findMany({
      orderBy: { finishedAt: "desc" },
      take: 100,
    });

    // Ø Dauer pro Aufgabenname
    const durationByName = new Map<string, number[]>();
    for (const r of runs) {
      const ms = r.finishedAt.getTime() - r.startedAt.getTime();
      const arr = durationByName.get(r.taskName) ?? [];
      arr.push(ms);
      durationByName.set(r.taskName, arr);
    }

    const avgByTask = Array.from(durationByName.entries()).map(([name, durations]) => ({
      taskName: name,
      avgMinutes: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000),
      runCount: durations.length,
    }));

    return { runs: runs.slice(0, 20), avgByTask };
  });

  // Mitarbeiter-Historie (aus WorkLog) über einen Zeitraum: je MA aktive Zeit,
  // Anzahl Schritte und beteiligte Durchläufe. Default: letzte 7 Tage.
  app.get("/employee-history", { preHandler: [authAdmin] }, async (req) => {
    const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { from, to } = z
      .object({ from: dateStr.optional(), to: dateStr.optional() })
      .parse(req.query);
    const { gte, lt } = rangeFromQuery(from, to);

    const logs = await prisma.workLog.findMany({
      where: { finishedAt: { gte, lt } },
      include: { employee: { select: { name: true } } },
    });

    type Agg = { name: string; activeMs: number; stepCount: number; runs: Set<string> };
    const byEmp = new Map<string, Agg>();
    for (const l of logs) {
      const e =
        byEmp.get(l.employeeId) ?? { name: l.employee.name, activeMs: 0, stepCount: 0, runs: new Set<string>() };
      e.activeMs += l.activeMs;
      e.stepCount += 1;
      e.runs.add(l.runId);
      byEmp.set(l.employeeId, e);
    }

    return Array.from(byEmp.entries())
      .map(([employeeId, v]) => ({
        employeeId,
        name: v.name,
        activeMinutes: Math.round(v.activeMs / 60000),
        stepCount: v.stepCount,
        taskCount: v.runs.size,
        avgStepMinutes: v.stepCount ? Math.round(v.activeMs / v.stepCount / 60000) : 0,
      }))
      .sort((a, b) => b.activeMinutes - a.activeMinutes);
  });

  // Durchsatz (aus TaskRun) über einen Zeitraum: je Tag Anzahl Läufe + Ø Dauer
  // (Tage ohne Läufe als 0), plus Ø Dauer je Aufgabentyp. Default: letzte 7 Tage.
  app.get("/throughput", { preHandler: [authAdmin] }, async (req) => {
    const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { from, to } = z
      .object({ from: dateStr.optional(), to: dateStr.optional() })
      .parse(req.query);
    const { gte, lt } = rangeFromQuery(from, to);

    const runs = await prisma.taskRun.findMany({
      where: { finishedAt: { gte, lt } },
      select: { taskName: true, startedAt: true, finishedAt: true },
    });

    const perDayMap = new Map<string, { runCount: number; totalMs: number }>();
    const perTaskMap = new Map<string, { runCount: number; totalMs: number }>();
    for (const r of runs) {
      const ms = r.finishedAt.getTime() - r.startedAt.getTime();
      const day = localDayKey(r.finishedAt);
      const d = perDayMap.get(day) ?? { runCount: 0, totalMs: 0 };
      d.runCount += 1;
      d.totalMs += ms;
      perDayMap.set(day, d);
      const t = perTaskMap.get(r.taskName) ?? { runCount: 0, totalMs: 0 };
      t.runCount += 1;
      t.totalMs += ms;
      perTaskMap.set(r.taskName, t);
    }

    const perDay = enumerateDays(gte, lt).map((day) => {
      const d = perDayMap.get(day);
      return {
        day,
        runCount: d?.runCount ?? 0,
        avgMinutes: d ? Math.round(d.totalMs / d.runCount / 60000) : 0,
      };
    });

    const avgByTask = Array.from(perTaskMap.entries())
      .map(([taskName, v]) => ({
        taskName,
        runCount: v.runCount,
        avgMinutes: Math.round(v.totalMs / v.runCount / 60000),
      }))
      .sort((a, b) => b.runCount - a.runCount);

    return { perDay, avgByTask };
  });

  // Ø Zeit je Arbeitsschritt (aus WorkLog) über einen Zeitraum, gruppiert nach
  // (Aufgabe, Schritt) – der Schrittname allein ist NICHT eindeutig (= Skillname,
  // kann in mehreren Aufgaben vorkommen), daher immer mit taskName zusammen.
  // Kennzahl = Netto-Aktivzeit pro Schritt-Vorkommen (activeMs, Unterbrechungen
  // abgezogen) je Person; bei Team-Schritten also pro MA, nicht die Wanduhr-Dauer.
  // Default: letzte 7 Tage.
  app.get("/step-durations", { preHandler: [authAdmin] }, async (req) => {
    const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { from, to } = z
      .object({ from: dateStr.optional(), to: dateStr.optional() })
      .parse(req.query);
    const { gte, lt } = rangeFromQuery(from, to);

    const logs = await prisma.workLog.findMany({
      where: { finishedAt: { gte, lt } },
      select: { taskName: true, stepName: true, activeMs: true },
    });

    type Agg = { count: number; totalMs: number; minMs: number; maxMs: number };
    // Schluessel aus zwei Namen. Trennzeichen ist NUL (\u0000), weil das Zeichen in
    // keinem Aufgaben- oder Schrittnamen vorkommen kann - ein sichtbares Trennzeichen
    // koennte selbst Teil eines Namens sein und zwei Gruppen verschmelzen lassen.
    const map = new Map<string, { taskName: string; stepName: string; agg: Agg }>();
    for (const l of logs) {
      const key = `${l.taskName}\u0000${l.stepName}`;
      const e =
        map.get(key) ??
        { taskName: l.taskName, stepName: l.stepName, agg: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 } };
      e.agg.count += 1;
      e.agg.totalMs += l.activeMs;
      e.agg.minMs = Math.min(e.agg.minMs, l.activeMs);
      e.agg.maxMs = Math.max(e.agg.maxMs, l.activeMs);
      map.set(key, e);
    }

    const toMin = (ms: number) => Math.round(ms / 60000);
    const steps = Array.from(map.values())
      .map(({ taskName, stepName, agg }) => ({
        taskName,
        stepName,
        count: agg.count,
        avgMinutes: toMin(agg.totalMs / agg.count),
        minMinutes: toMin(agg.minMs === Infinity ? 0 : agg.minMs),
        maxMinutes: toMin(agg.maxMs),
      }))
      // primär nach Aufgabe, sekundär längster Ø zuerst (auffällige Schritte oben)
      .sort((a, b) => (a.taskName === b.taskName ? b.avgMinutes - a.avgMinutes : a.taskName < b.taskName ? -1 : 1));

    return { steps };
  });

  // MA-Detail-Auswertung: für EINEN Mitarbeiter + Zeitraum die Blöcke 1,2,3,D,E+F
  // (tabellarisch im Frontend). Aktive Zeit/Schritte aus WorkLog; Notizen aus den
  // TaskRun-Snapshots; "inaktive Zeit" aus der echten Crewmeister-Arbeitszeit:
  //   inaktiv(Tag) = max(0, Crewmeister-WORKING_TIME(Tag) − Σ LagerHub-Aktivzeit(Tag))
  // Auch Tage OHNE abgeschlossenen Schritt erscheinen, sofern Arbeitszeit gestempelt
  // wurde (dann voll inaktiv). Ohne Crewmeister-Zuordnung/-Erreichbarkeit bleiben
  // die Inaktiv-Felder null (Rest funktioniert weiter). "Wechsel" = switchCount (wie
  // OFT der MA den Schritt gewechselt/unterbrochen hat, NICHT die Dauer; Feierabend
  // zählt nicht). Alte Läufe (vor der switchCount-Migration) = 0.
  app.get("/employee-detail", { preHandler: [authAdmin] }, async (req, reply) => {
    const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { employeeId, from, to } = z
      .object({ employeeId: z.string().uuid(), from: dateStr.optional(), to: dateStr.optional() })
      .parse(req.query);
    const { gte, lt } = rangeFromQuery(from, to);
    const fromKey = localDayKey(gte);
    const toKey = localDayKey(new Date(lt.getTime() - 1)); // letzter eingeschlossener Tag

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, crewmeisterUserId: true },
    });
    if (!employee) return reply.status(404).send({ error: "Mitarbeiter nicht gefunden" });

    const logs = await prisma.workLog.findMany({
      where: { employeeId, finishedAt: { gte, lt } },
      select: {
        runId: true,
        taskName: true,
        stepName: true,
        startedAt: true,
        finishedAt: true,
        activeMs: true,
        switchCount: true,
      },
      orderBy: { finishedAt: "desc" },
    });

    // Notizen je (runId, stepName) aus den TaskRun-Snapshots nachladen (eine Abfrage).
    const runIds = [...new Set(logs.map((l) => l.runId))];
    const runs = runIds.length
      ? await prisma.taskRun.findMany({ where: { id: { in: runIds } }, select: { id: true, data: true } })
      : [];
    const notesByRunStep = new Map<string, Map<string, NoteEntry[]>>();
    for (const r of runs) {
      const byStep = new Map<string, NoteEntry[]>();
      for (const s of ((r.data as RunSnapshot)?.steps ?? [])) {
        if (s.name) byStep.set(s.name, asNoteArray(s.notes));
      }
      notesByRunStep.set(r.id, byStep);
    }

    const toMin = (ms: number) => Math.round(ms / 60000);

    // --- Block 3: Einzelvorkommen (flach, Frontend gruppiert nach stepName) ---
    const occurrences = logs.map((l) => ({
      runId: l.runId,
      stepName: l.stepName,
      taskName: l.taskName,
      date: localDayKey(l.finishedAt),
      activeMinutes: toMin(l.activeMs),
      switchCount: l.switchCount,
      notes: notesByRunStep.get(l.runId)?.get(l.stepName) ?? [],
    }));

    // --- Block 2: je Schritttyp ---
    type StepAgg = { count: number; activeMs: number; switchCount: number; minMs: number; maxMs: number };
    const byStepMap = new Map<string, StepAgg>();
    for (const l of logs) {
      const s = byStepMap.get(l.stepName) ?? {
        count: 0,
        activeMs: 0,
        switchCount: 0,
        minMs: Infinity,
        maxMs: 0,
      };
      s.count += 1;
      s.activeMs += l.activeMs;
      s.switchCount += l.switchCount;
      s.minMs = Math.min(s.minMs, l.activeMs);
      s.maxMs = Math.max(s.maxMs, l.activeMs);
      byStepMap.set(l.stepName, s);
    }
    const byStep = Array.from(byStepMap.entries())
      .map(([stepName, s]) => ({
        stepName,
        count: s.count,
        totalActiveMinutes: toMin(s.activeMs),
        avgActiveMinutes: toMin(s.activeMs / s.count),
        // Ø Wechsel je Vorkommen (eine Nachkommastelle).
        avgSwitchCount: Math.round((s.switchCount / s.count) * 10) / 10,
        minActiveMinutes: toMin(s.minMs === Infinity ? 0 : s.minMs),
        maxActiveMinutes: toMin(s.maxMs),
      }))
      .sort((a, b) => b.totalActiveMinutes - a.totalActiveMinutes);

    // --- Block D: Aufgaben-Verteilung (Anteil an aktiver Zeit) ---
    const totalActiveMs = logs.reduce((sum, l) => sum + l.activeMs, 0);
    const byTaskMap = new Map<string, { count: number; activeMs: number }>();
    for (const l of logs) {
      const t = byTaskMap.get(l.taskName) ?? { count: 0, activeMs: 0 };
      t.count += 1;
      t.activeMs += l.activeMs;
      byTaskMap.set(l.taskName, t);
    }
    const byTask = Array.from(byTaskMap.entries())
      .map(([taskName, t]) => ({
        taskName,
        count: t.count,
        activeMinutes: toMin(t.activeMs),
        sharePercent: totalActiveMs > 0 ? Math.round((t.activeMs / totalActiveMs) * 100) : 0,
      }))
      .sort((a, b) => b.activeMinutes - a.activeMinutes);

    // --- Aktive LagerHub-Zeit + Schrittzahl je Tag (Grundlage E+F & Inaktiv) ---
    const activeMsByDay = new Map<string, number>();
    const stepCountByDay = new Map<string, number>();
    for (const l of logs) {
      const day = localDayKey(l.finishedAt);
      activeMsByDay.set(day, (activeMsByDay.get(day) ?? 0) + l.activeMs);
      stepCountByDay.set(day, (stepCountByDay.get(day) ?? 0) + 1);
    }

    // --- Crewmeister-Arbeitszeit je Tag holen (für inaktive Zeit) ---
    let workMinutesByDay: Map<string, number> | null = null;
    let crewmeister: { available: boolean; reason?: string };
    if (employee.crewmeisterUserId == null) {
      crewmeister = { available: false, reason: "Keine Crewmeister-Zuordnung" };
    } else if (!crewmeisterConfigured()) {
      crewmeister = { available: false, reason: "Crewmeister nicht konfiguriert" };
    } else {
      try {
        const map = await getWorkingMinutes(fromKey, toKey, employee.crewmeisterUserId);
        workMinutesByDay = map.get(employee.crewmeisterUserId) ?? new Map();
        crewmeister = { available: true };
      } catch (err) {
        crewmeister = {
          available: false,
          reason: err instanceof CrewmeisterError ? err.message : "Crewmeister nicht erreichbar",
        };
      }
    }

    // inaktiv(Tag) nur für Tage mit ≥1 Schritt; null wenn Crewmeister nicht verfügbar.
    const inactiveMinutesForDay = (day: string): number | null => {
      if (!workMinutesByDay) return null;
      const work = workMinutesByDay.get(day) ?? 0;
      const active = (activeMsByDay.get(day) ?? 0) / 60000;
      return Math.max(0, Math.round(work - active));
    };

    // --- Block E+F: Pro-Tag-Tabelle, absteigend ---
    // Tage mit abgeschlossenen Schritten PLUS (falls Crewmeister verfügbar) Tage mit
    // gestempelter Arbeitszeit ohne fertigen Schritt. Letztere stehen als voller
    // Leerlauf-Tag drin (0 Schritte / 0 min aktiv / gestempelte Zeit inaktiv) – ohne
    // diese Vereinigung fiele ein eingestempelter Tag ohne Schritt-Abschluss komplett
    // aus der Auswertung, statt als inaktive Zeit sichtbar zu werden.
    const dayKeys = new Set(stepCountByDay.keys());
    if (workMinutesByDay) {
      for (const [day, minutes] of workMinutesByDay) {
        if (minutes > 0) dayKeys.add(day);
      }
    }
    const perDay = [...dayKeys]
      .sort((a, b) => (a < b ? 1 : -1))
      .map((day) => ({
        date: day,
        stepCount: stepCountByDay.get(day) ?? 0,
        activeMinutes: toMin(activeMsByDay.get(day) ?? 0),
        inactiveMinutes: inactiveMinutesForDay(day),
      }));

    const totalInactive = workMinutesByDay
      ? perDay.reduce((sum, d) => sum + (d.inactiveMinutes ?? 0), 0)
      : null;

    // --- Block 1: Kopf-KPIs ---
    const totals = {
      activeMinutes: toMin(totalActiveMs),
      switchCount: logs.reduce((sum, l) => sum + l.switchCount, 0),
      inactiveMinutes: totalInactive,
      stepCount: logs.length,
      runCount: runIds.length,
      stepTypeCount: byStepMap.size,
    };

    return {
      employeeId: employee.id,
      name: employee.name,
      crewmeisterUserId: employee.crewmeisterUserId,
      from: fromKey,
      to: toKey,
      crewmeister,
      totals,
      byStep,
      occurrences,
      byTask,
      perDay,
    };
  });
};
