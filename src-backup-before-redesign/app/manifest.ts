import type { MetadataRoute } from "next";

/**
 * Native Next.js manifest route (app/manifest.ts) — served at /manifest.webmanifest.
 * PWA foundation only: installability metadata and icon. Offline caching /
 * service-worker behavior is deliberately out of scope for Phase 0.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PAY2PAY",
    short_name: "PAY2PAY",
    description: "Ethical, interest-free repayment agreements.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f4c3a",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
