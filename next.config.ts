import type { NextConfig } from "next";

// Vercel functions reject request bodies above 4.5 MB before the app code runs, whatever
// limit the app sets, so uploads must be capped there too. VERCEL=1 is set on its builds.
const VERCEL_MAX_UPLOAD_BYTES = 4_400_000;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_HOSTING_MAX_UPLOAD_BYTES: process.env.VERCEL ? String(VERCEL_MAX_UPLOAD_BYTES) : "",
  },
};

export default nextConfig;
