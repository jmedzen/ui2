import type { Metadata, Viewport } from 'next';
import './globals.css';

import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_SUBTITLE,
  absoluteUrl,
  siteUrl
} from '@/lib/site';

/**
 * The share preview is generated from these fields, not from the page body, so
 * the site name has to appear here or social cards keep showing the upstream
 * archive's name.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: `${SITE_NAME} - ${SITE_SUBTITLE}`,
    template: `%s | ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    SITE_NAME,
    '玅境長老',
    '法雲寺',
    '瑜伽師地論',
    '金剛經',
    '摩訶般若波羅蜜經',
    '阿含經',
    '禪修',
    '佛法',
    'fayun.org'
  ],
  authors: [{ name: '玅境長老 (講述)' }],
  publisher: SITE_NAME,
  creator: SITE_NAME,
  alternates: {
    canonical: '/'
  },
  icons: {
    icon: [
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: ['/icon-32.png']
  },
  // iOS takes the home-screen label from here, not from the manifest.
  appleWebApp: {
    title: SITE_NAME,
    capable: true,
    statusBarStyle: 'default'
  },
  openGraph: {
    type: 'website',
    locale: 'zh_TW',
    url: absoluteUrl('/'),
    siteName: SITE_NAME,
    title: `${SITE_NAME} - ${SITE_SUBTITLE}`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — ${SITE_SUBTITLE}`
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} - ${SITE_SUBTITLE}`,
    description: SITE_DESCRIPTION,
    images: ['/og-image.png']
  },
  other: {
    // Attribution, not branding: the audio/video/PDF material belongs to
    // fayun.org, so the rights holder stays named here.
    'copyright': `© 版權所有：法雲資訊網 (fayun.org) ｜ ${SITE_NAME}典藏平台 | 僅供學修弘法無償流通`
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f7f2e8'
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
