const DEMO_URL = process.env.DEMO_URL ?? "http://127.0.0.1:8002";
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/demo/:path*", destination: `${DEMO_URL}/demo/:path*` },
      { source: "/api/coord/:path*", destination: `${COORDINATOR_URL}/:path*` }
    ];
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"]
};

export default nextConfig;