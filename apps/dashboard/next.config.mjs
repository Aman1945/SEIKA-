/** @type {import('next').NextConfig} */
/*
 * SEIKA_STATIC_BASE turns the app into a static export for the demo build.
 *
 * Nothing here is server-rendered — no route handlers, no server actions, no
 * dynamic segments — so the whole app is files nginx can serve directly. That
 * matters because the demo goes onto a machine that already runs another
 * product: static files add a directory, where `next start` would add a long
 * running Node process to keep alive and watch.
 *
 * Unset, the app builds and runs exactly as before.
 */
const staticBase = process.env.SEIKA_STATIC_BASE;

const nextConfig = {
  reactStrictMode: true,
  ...(staticBase
    ? {
        output: "export",
        basePath: staticBase,
        // The export has no server, so Next cannot rewrite /x to /x/ at
        // request time. Directory-style output lets nginx resolve it.
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  // The shared packages ship TypeScript source, not a build step, so Next has
  // to compile them along with the app.
  transpilePackages: ["@seika/sdk", "@seika/types"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  },
};

export default nextConfig;
