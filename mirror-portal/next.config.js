/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Le route di /strumento-rete leggono design-tool/ dal disco (docs/security.md voce #139): senza queste righe il
  // tracciamento dei file di Vercel non le vede e le funzioni non le troverebbero. Le chiavi si confrontano per
  // sottostringa con il percorso della route (la prima copre già la seconda: la seconda resta per chiarezza); verifica
  // dopo un build con: grep design-tool .next/server/app/strumento-rete/route.js.nft.json
  // Il percorso è relativo alla cartella del progetto: la Root Directory di Vercel deve essere mirror-portal/.
  experimental: {
    outputFileTracingIncludes: {
      "/strumento-rete": ["./design-tool/**/*"],
      "/strumento-rete/data/[file]": ["./design-tool/**/*"],
    },
  },
};

module.exports = nextConfig;
