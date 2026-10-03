import { afterEach, describe, expect, it, vi } from "vitest";

// Die Admin-PINs entscheiden über die Dashboard-VOLLANSICHT (Rolle ADMIN) und
// stehen nur in der .env. Ein Fehler im Parser ist damit ein Zugangs-Fehler in
// beide Richtungen: eine zu großzügige Erkennung öffnet die Vollansicht, eine zu
// strenge sperrt den Betreiber aus. Deshalb wird hier vor allem geprüft, was
// NICHT als Admin-PIN durchgeht.
//
// Das Modul cacht die geparste Map beim ersten Zugriff (lazy, damit dotenv
// sicher gelaufen ist). Für jeden Fall daher frisch laden: vi.resetModules()
// + dynamischer Import, sonst wirkt der Cache des vorherigen Tests.
async function loadWith(adminPins: string | undefined) {
  vi.resetModules();
  if (adminPins === undefined) delete process.env.ADMIN_PINS;
  else process.env.ADMIN_PINS = adminPins;
  return import("./adminPins.js");
}

const originalEnv = process.env.ADMIN_PINS;

afterEach(() => {
  // Echte PINs aus der .env-Umgebung nicht durch Testwerte ersetzt zurücklassen.
  if (originalEnv === undefined) delete process.env.ADMIN_PINS;
  else process.env.ADMIN_PINS = originalEnv;
});

describe("adminForPin", () => {
  it("erkennt eine konfigurierte PIN und liefert ihren Namen", async () => {
    const { adminForPin } = await loadWith("1234:Admin,5678:Chef");

    expect(adminForPin("1234")).toEqual({ name: "Admin" });
    expect(adminForPin("5678")).toEqual({ name: "Chef" });
  });

  it("liefert null für eine unbekannte PIN", async () => {
    const { adminForPin } = await loadWith("1234:Admin");

    expect(adminForPin("9999")).toBeNull();
  });

  // Ohne Namen ist der Eintrag trotzdem gültig – der Anzeigename ist Komfort,
  // nicht Teil des Geheimnisses.
  it("setzt „Admin“ als Namen, wenn keiner angegeben ist", async () => {
    const { adminForPin } = await loadWith("1234");

    expect(adminForPin("1234")).toEqual({ name: "Admin" });
  });

  it("toleriert Leerzeichen um PIN und Name", async () => {
    const { adminForPin } = await loadWith("  1234 : Chef  ");

    expect(adminForPin("1234")).toEqual({ name: "Chef" });
  });
});

// Der wichtigste Block: alles, was KEINE Admin-PIN sein darf. Die PIN-Form
// (genau 4 Ziffern) ist dieselbe wie beim Mitarbeiter-Login – ein Eintrag, der
// diese Form verfehlt, könnte über /pin-login ohnehin nie ankommen und wäre
// stillschweigend wirkungslos. Er wird deshalb hier schon verworfen.
describe("adminForPin – ungültige Konfiguration", () => {
  it.each([
    ["zu kurz", "123:Admin", "123"],
    ["zu lang", "12345:Admin", "12345"],
    ["nicht numerisch", "abcd:Admin", "abcd"],
    ["teilweise numerisch", "12a4:Admin", "12a4"],
  ])("verwirft eine PIN, die %s ist", async (_fall, config, pin) => {
    const { adminForPin, isAdminPin } = await loadWith(config);

    expect(adminForPin(pin)).toBeNull();
    expect(isAdminPin(pin)).toBe(false);
  });

  // Der entscheidende Fall für den Auslieferungszustand: ohne gesetzte Variable
  // darf es KEINEN Admin geben. Ein Default-Admin wäre ein offenes Tor.
  it.each([
    ["nicht gesetzt", undefined],
    ["leer", ""],
    ["nur Trennzeichen", ",,"],
  ])("kennt keinen Admin, wenn ADMIN_PINS %s ist", async (_fall, config) => {
    const { adminForPin, isAdminPin } = await loadWith(config);

    expect(adminForPin("1234")).toBeNull();
    expect(adminForPin("")).toBeNull();
    expect(isAdminPin("1234")).toBe(false);
  });

  // Ein kaputter Eintrag darf die übrigen nicht mitreißen (der Parser läuft je
  // Eintrag, nicht über die ganze Zeile).
  it("überspringt einen ungültigen Eintrag und behält die gültigen", async () => {
    const { adminForPin } = await loadWith("abc:Kaputt,1234:Chef");

    expect(adminForPin("abc")).toBeNull();
    expect(adminForPin("1234")).toEqual({ name: "Chef" });
  });
});

describe("isAdminPin", () => {
  // Wird beim Anlegen eines Mitarbeiters gebraucht: die Auto-PIN-Vergabe darf
  // keine reservierte Admin-PIN ziehen, sonst bekäme ein Lager-MA beim Login
  // die Vollansicht.
  it("meldet reservierte PINs, damit sie nicht an Mitarbeiter vergeben werden", async () => {
    const { isAdminPin } = await loadWith("1234:Admin,5678:Chef");

    expect(isAdminPin("1234")).toBe(true);
    expect(isAdminPin("5678")).toBe(true);
    expect(isAdminPin("4321")).toBe(false);
  });
});

describe("Cache-Verhalten", () => {
  // Dokumentiert eine bewusste Eigenschaft: die Map wird EINMAL geparst. Eine
  // Änderung an ADMIN_PINS wirkt erst nach einem Neustart des Servers – wer die
  // PINs wechselt, muss neu starten.
  it("liest ADMIN_PINS nur beim ersten Zugriff", async () => {
    const { adminForPin } = await loadWith("1234:Admin");
    expect(adminForPin("1234")).toEqual({ name: "Admin" });

    process.env.ADMIN_PINS = "9999:Neu";

    expect(adminForPin("9999")).toBeNull();
    expect(adminForPin("1234")).toEqual({ name: "Admin" });
  });
});
