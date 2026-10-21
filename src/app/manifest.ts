import type { MetadataRoute } from 'next';

import { SITE_DESCRIPTION, SITE_NAME, SITE_SUBTITLE } from '@/lib/site';

/**
 * PWA manifest.
 *
 * Icon paths are relative to `scope`, which is what the spec resolves them
 * against; they deliberately do not embed the origin, so the same build works
 * on the production domain and on a preview host.
 *
 * Icons are PNG rather than the stock SVG set: Android and iOS will not install
 * a manifest whose icons it cannot decode, and `purpose: maskable` needs the
 * blossom to survive a circular crop, which the artwork is padded for.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — ${SITE_SUBTITLE}`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f7f2e8',
    theme_color: '#c67c13',
    lang: 'zh-TW',
    dir: 'ltr',
    categories: ['education', 'books'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
