import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { purgeOldJournals } from "../services/journalRetention.js";
import { authAdmin, authAny } from "../auth.js";

// "HH:mm" mit gültiger Uhrzeit – die alte Regex \d{2}:\d{2} ließ auch "99:99" durch.
const TimeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:mm erwartet");

const UpdateSettingsSchema = z
  .object({
    workStart: TimeString.optional(),
    workEnd: TimeString.optional(),
    escalationMins: z.number().int().positive().max(1440).optional(),
    // Pause, in der die Eskalation schweigt. Gleiche Zeiten = keine Pause.
    breakStart: TimeString.optional(),
    breakEnd: TimeString.optional(),
    // Aufbewahrungsdauer der Journale in Tagen; 0 = deaktiviert. Obergrenze ~10 J.
    journalRetentionDays: z.number().int().min(0).max(3650).optional(),
  })
  // Ein Feld allein zu prüfen genügt nicht: die Werte müssen ZUEINANDER passen,
  // und ein PATCH kann nur eines der beiden mitschicken. Die Prüfung läuft daher
  // gegen den Stand NACH dem Merge – siehe unten, wo `current` reingereicht wird.
  .strict();

// Ende muss nach Beginn liegen. Über Mitternacht gibt es hier bewusst nicht:
// weder eine Arbeitszeit noch eine Pause läuft im Betrieb über den Tageswechsel,
// und quietHours/isWithinWorkHours rechnen beide in Minuten seit Mitternacht.
// Ausnahme Pause: start == end heißt „deaktiviert" und ist erlaubt.
function assertOrdered(
  label: string,
  start: string,
  end: string,
  allowEqual: boolean
): void {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const diff = toMin(end) - toMin(start);
  if (allowEqual ? diff < 0 : diff <= 0) {
    const err: Error & { statusCode?: number } = new Error(
      `${label}: Ende muss nach dem Beginn liegen.`
    );
    err.statusCode = 400;
    throw err;
  }
}

async function getOrCreateSettings() {
  return prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Lesen: authAny statt authDashboard – die PWA (WORKER) braucht
  // `escalationMins`, um das Alter eines wartenden Schritts einzufärben. Ohne das
  // müsste sie einen eigenen Schwellwert erfinden und würde etwas anderes als
  // „zu lange" bezeichnen als die Eskalation selbst.
  // Der Inhalt sind Betriebsparameter (Arbeitszeiten, Schwellwerte), keine
  // Geheimnisse; Schreiben bleibt `authManager`.
  app.get("/", { preHandler: [authAny] }, async () => {
    return getOrCreateSettings();
  });

  // Schreiben nur ADMIN: die Einstellungen sind im Dashboard ein eigener,
  // ADMIN-exklusiver Tab. Vorher authManager – mit dem Tab wäre das eine reine
  // Oberflächen-Sperre gewesen, die per API zu umgehen ist.
  app.patch("/", { preHandler: [authAdmin] }, async (req) => {
    const body = UpdateSettingsSchema.parse(req.body);

    // Gegen den Stand NACH dem Merge prüfen: ein PATCH darf einzelne Felder
    // schicken, „workEnd allein" muss also gegen das gespeicherte workStart
    // geprüft werden – sonst ließe sich die Ordnung in zwei Schritten aushebeln.
    const current = await getOrCreateSettings();
    const merged = { ...current, ...body };
    assertOrdered("Arbeitszeit", merged.workStart, merged.workEnd, false);
    assertOrdered("Pause", merged.breakStart, merged.breakEnd, true);

    const settings = await prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...body },
      update: body,
    });

    publish("lagerhub", { type: "SETTINGS_UPDATED", settings });

    // Bei geänderter Aufbewahrungsdauer sofort aufräumen, damit der Effekt direkt
    // sichtbar ist (statt erst beim nächtlichen Lauf). purgeOldJournals sendet bei
    // tatsächlichen Löschungen sein eigenes JOURNAL_DELETED-Event.
    if (body.journalRetentionDays !== undefined) {
      await purgeOldJournals();
    }

    return settings;
  });
};
