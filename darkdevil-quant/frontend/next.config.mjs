/** @type {import('next').NextConfig} */
const API_UPSTREAM = process.env.DJQ_API_UPSTREAM || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_UPSTREAM}/api/:path*` },
    ];
  },
};

export default nextConfig;
