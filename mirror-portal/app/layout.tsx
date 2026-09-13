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
      <head>
        {/* Restyle 11-13 settembre 2026 (docs/security.md voce #75) — unico link esterno di questo
            progetto, per due font non di sistema (globals.css li usa come "Public Sans"/"IBM Plex
            Mono", con fallback a stack di sistema se il link fallisce a caricare). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
