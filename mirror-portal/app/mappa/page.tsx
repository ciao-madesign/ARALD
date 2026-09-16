import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getMirrorSnapshot, type MirrorSectionError, type MirrorSnapshot } from "../../lib/db";
import { toMapPoints } from "../../lib/map-points";
import { PortalHeader } from "../PortalHeader";
import { MapClient } from "./MapClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function sectionError(errors: MirrorSectionError[], section: MirrorSectionError["section"]): string | undefined {
  return errors.find((e) => e.section === section)?.message;
}

const SECTION_LABELS: Record<Exclude<MirrorSectionError["section"], "config">, string> = {
  nodes: "nodi",
  beacons: "SOS",
  drops: "hazard/info",
  relays: "relay",
  // "Consegna esterna differita" destinations never put a pin on this map (no lat/lon of their own) —
  // included only because SECTION_LABELS' own type requires every non-"config" section, not because
  // this page ever surfaces a "destinations" failure to the operator.
  destinations: "destinazioni",
};

export default async function MapPage(): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const organizationId = session.user.role === "admin" ? undefined : session.user.organizationId ?? "";

  let snapshot: MirrorSnapshot;
  try {
    snapshot = await getMirrorSnapshot(organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    snapshot = { nodes: [], relays: [], beacons: [], drops: [], destinations: [], errors: [{ section: "config", message }] };
  }

  const configError = sectionError(snapshot.errors, "config");
  const points = configError ? [] : toMapPoints(snapshot);
  const nodeCount = snapshot.nodes.length;

  // The three sections that can actually put a pin on this map — a nodes-only failure never affects
  // what's plotted here, so (unlike app/page.tsx, which shows every section's error inline in its own
  // panel) it's deliberately left out of this list: surfacing it on the Mappa screen would warn about
  // something that provably has no effect on this screen's own content, which would just teach an
  // operator to distrust warnings here.
  const partialErrors: string[] = [];
  if (!configError) {
    for (const section of ["beacons", "drops", "relays"] as const) {
      const message = sectionError(snapshot.errors, section);
      if (message) partialErrors.push(`${SECTION_LABELS[section]}: ${message}`);
    }
  }

  return (
    <>
      <PortalHeader
        userEmail={session.user.email ?? ""}
        roleLabel={session.user.role === "admin" ? "Admin ARALD" : "Operatore"}
        active="mappa"
        isAdmin={session.user.role === "admin"}
      />

      {configError ? (
        <main className="content">
          <div className="content-inner">
            <div className="panel error">
              <strong>Impossibile leggere i dati dello specchio.</strong>
              <p>{configError}</p>
            </div>
          </div>
        </main>
      ) : (
        <MapClient points={points} nodeCount={nodeCount} partialErrors={partialErrors} />
      )}
    </>
  );
}
