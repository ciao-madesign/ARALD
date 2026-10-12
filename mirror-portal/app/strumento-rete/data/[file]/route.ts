import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "@/auth";
import { DESIGN_TOOL_DATA_FILE } from "../../../../lib/design-tool-page";

/**
 * Catalogo e pacchetti di terreno del Network Design Tool, solo con una sessione valida. Il nome del file passa da una
 * lista chiusa di forme (`DESIGN_TOOL_DATA_FILE`): mai un percorso costruito da ciò che arriva dalla richiesta.
 * Le funzioni di Vercel rispondono al più con 4,5 MB: i pacchetti pesano 24-240 KB; uno futuro oltre quel limite andrebbe
 * servito diversamente (o ridotto).
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { file: string } }): Promise<Response> {
  const session = await auth();
  if (!session?.user) return new Response("Accesso non autorizzato", { status: 401, headers: { "Cache-Control": "no-store" } });
  const name = params.file;
  if (!DESIGN_TOOL_DATA_FILE.test(name)) return new Response("Non trovato", { status: 404, headers: { "Cache-Control": "no-store" } });
  let body: Buffer;
  try {
    body = await readFile(join(process.cwd(), "design-tool", "data", name));
  } catch {
    return new Response("Non trovato", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(body, {
    headers: {
      "Content-Type": name.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
      // dietro la sessione, ma statici: il browser può tenerli un'ora (cambiano solo con una nuova sincronizzazione della copia)
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
