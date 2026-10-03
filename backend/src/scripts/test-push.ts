// dotenv MUSS zuerst geladen werden: services/push.ts liest die VAPID-Keys beim
// Import aus process.env – ohne geladene .env wäre Push "nicht konfiguriert".
import "dotenv/config";
import { prisma } from "../db.js";
import { sendPushToEmployees } from "../services/push.js";

// Dev-Hilfsskript zum Testen der M4-Push-Pipeline: schickt einen ECHTEN Web-Push
// an einen Mitarbeiter – über den realen Push-Dienst, an dessen in der PWA
// gespeicherte Geräte-Abos. Voraussetzung: der MA hat in der PWA (auf localhost,
// Secure Context) „Benachrichtigungen aktivieren" gedrückt.
//
//   npm run test:push -- <MA-Name|MA-Id> ["Titel"] ["Text"]
async function main() {
  const who = process.argv[2];
  if (!who) {
    console.error('Aufruf: npm run test:push -- <MA-Name|Id> ["Titel"] ["Text"]');
    process.exit(1);
  }
  const title = process.argv[3] ?? "LagerHub Test";
  const body = process.argv[4] ?? "Test-Benachrichtigung – die Pipeline läuft 🎉";

  const emp = await prisma.employee.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: who }, { name: { equals: who, mode: "insensitive" } }],
    },
    select: { id: true, name: true },
  });
  if (!emp) {
    console.error(`Kein (aktiver) Mitarbeiter gefunden für "${who}".`);
    process.exit(1);
  }

  const subs = await prisma.pushSubscription.count({ where: { employeeId: emp.id } });
  console.log(`Mitarbeiter: ${emp.name} | gespeicherte Geräte-Abos: ${subs}`);
  if (subs === 0) {
    console.error("Kein Abo vorhanden. Erst in der PWA (localhost) 'Benachrichtigungen aktivieren' druecken.");
    process.exit(1);
  }

  await sendPushToEmployees([emp.id], { title, body });
  console.log(`Push an ${emp.name} gesendet: „${title}" – „${body}"`);
  console.log("(Zustellung ist best-effort; abgelaufene Abos räumt der Service selbst auf.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
