import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the project root explicitly. Without this, Turbopack's upward
    // directory scan for a lockfile can notice one in a parent directory
    // outside this project and emit a "package-lock.json ignored" warning.
    // This setting silences that warning by declaring PAY2PAY itself as the
    // root — it does not read, reference, or depend on anything outside
    // this directory.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
