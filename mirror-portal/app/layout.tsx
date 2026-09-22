import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ARALD — Specchio Emergency Portal",
  description: "Vista di sola lettura sui dati sincronizzati da un ARALD Box (docs/emergency-portal.md).",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="it">
      {/* Migrazione token Waypoint, Fase 3 dell'audit UX/UI (docs/security.md voce #88): i font non
          sono più caricati da Google Fonts (il link esterno che stava qui) — `globals.css` li
          dichiara ora via `@font-face` auto-ospitati da `public/fonts/` (stessi file woff2 dell'app
          mobile), niente più dipendenza da una CDN esterna per questo portale. */}
      <body>{children}</body>
    </html>
  );
}
