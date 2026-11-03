import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Allow the dev server to be reached from the preview proxy / agent-browser.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
