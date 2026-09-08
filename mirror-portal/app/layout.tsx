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
      <body>{children}</body>
    </html>
  );
}
