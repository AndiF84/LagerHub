// Diagramm-Farben, abgeleitet aus der Marken-Palette (Navy #212C3D / Gold #EEC643).
//
// Die Marken-Farben selbst taugen NICHT als Datenfarben – nachgerechnet, nicht geschätzt:
//   Navy #212C3D → OKLCH L 0.29, C 0.035  = zu dunkel UND unter der Chroma-Grenze
//                  (eine Farbe mit C < 0.10 liest sich als Grau und trägt keine Bedeutung mehr)
//   Gold #EEC643 → OKLCH L 0.84, Kontrast 1.6:1 auf Weiß = zu hell für Datenflächen
//
// Deshalb je Marken-Farbton eine abgeleitete Stufe, die den FARBTON hält und nur
// Helligkeit/Chroma in den lesbaren Bereich rückt:
//   Navy H 258.9° → #2c5aa0 (H 258.7°, L 0.47, C 0.12)
//   Gold H  91.4° → #a4861c (H  91.6°, L 0.63, C 0.12)
// Der Farbton weicht damit um 0.2° ab – es sind dieselben Marken-Farben, nur in
// einer Stufe, die als Datenfläche funktioniert.
//
// Geprüft (Helligkeitsband, Chroma-Untergrenze, Farbfehlsichtigkeit protan/deutan/
// tritan, Kontrast ≥ 3:1 gegen Weiß): alle Checks bestanden, schlechtestes Paar
// ΔE 26.6 gegen ein Ziel von ≥ 8.
//
// Reihenfolge ist FEST: Slot 1 zuerst, nie durchrotieren. Alle Diagramme der
// Auswertung haben genau EINE Datenreihe und nutzen daher Slot 1 – der Titel
// benennt sie, eine Legende entfällt. Slot 2 ist erst für ein Diagramm mit zwei
// Reihen gedacht.
export const CHART_COLORS = ["#2c5aa0", "#a4861c"] as const;

// Zurückhaltende Chrome-Farben: Gitter und Achsen sollen hinter den Daten
// zurücktreten (entspricht --border bzw. --muted aus styles.css).
export const CHART_GRID = "#e3e5e8";
export const CHART_AXIS = "#6b7280";
