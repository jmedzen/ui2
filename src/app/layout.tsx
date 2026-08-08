import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '法雲資訊網 - 玅境長老經典講記音訊與講義典藏庫',
  description: '完美呈現 fayun.org 完整課程資料，包含佛法經論、禪修止觀、戒律開示之 MP3 音訊播放與 PDF 講義筆記閱讀平台。',
  keywords: ['法雲寺', '玅境長老', '瑜伽師地論', '金剛經', '摩訶般若波羅蜜經', '阿含經', '禪修', '佛法'],
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
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
