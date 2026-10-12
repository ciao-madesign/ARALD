import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { designToolCsp } from "../../lib/design-tool-page";

/**
 * Network Design Tool (`tools/network-design/`) per gli operatori: pagina statica generata da
 * `npm run design-tool:mirror-sync` e servita solo con una sessione valida — qualunque ruolo (Admin ARALD o
 * Operatore), il tool non legge dati dello specchio (docs/security.md voce #139). Come ogni pagina di questo portale,
 * il controllo sta qui e non in un middleware (vedi `auth.ts`).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return NextResponse.redirect(new URL("/login", req.url), 302);
  let html: string;
  try {
    html = await readFile(join(process.cwd(), "design-tool", "index.html"), "utf8");
  } catch {
    // la copia non è nel pacchetto distribuito (tracciamento dei file, cartella radice del progetto): messaggio chiaro, non un 500 muto
    return new Response("Strumento non disponibile: la copia della pagina manca dal pacchetto distribuito (design-tool/).", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": designToolCsp(html),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
