import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1', '192.168.2.166'],
  outputFileTracingExcludes: {
    '*': ['./next.config.ts'],
  },
  /**
   * Deep links for courses.
   *
   * `/course/97` and `/course/97/ep/12` are served by the single-page catalog at
   * `/`, and the client reads the real URL (not the rewritten destination) to
   * decide which course and episode to open.
   *
   * A real `[id]` route was the alternative, but it remounts the app shell on
   * navigation, which tears down the audio element and stops playback — the one
   * behaviour this player exists to guarantee. A rewrite keeps the URL
   * shareable and bookmarkable without that cost.
   */
  async rewrites() {
    return [
      { source: '/course/:id', destination: '/' },
      { source: '/course/:id/ep/:ep', destination: '/' }
    ];
  },
};

export default nextConfig;
