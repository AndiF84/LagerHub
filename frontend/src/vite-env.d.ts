/// <reference types="vite/client" />
// Bindet die Typen ein, die Vite selbst mitliefert: Seiteneffekt-Importe von
// Nicht-JS-Dateien (`import "./styles.css"`), Asset-Importe und import.meta.env.
// Ohne diese Zeile bricht der Build ab TypeScript 7 mit TS2882 ab - die frueheren
// Versionen haben den CSS-Import stillschweigend geschluckt.
