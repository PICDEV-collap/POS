import { Noto_Sans_Thai } from 'next/font/google';
import './globals.css';
import SafariViewport from './safari-viewport';

const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-noto-thai',
});

export const metadata = {
  title: 'สั่งอาหาร — POS V2',
  description: 'สั่งอาหารผ่าน QR code',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1c2342',
};

export default function RootLayout({ children }) {
  return (
    <html lang="th" className={notoSansThai.variable}>
      <body className={`min-h-screen ${notoSansThai.className}`}>
        <SafariViewport />
        {children}
      </body>
    </html>
  );
}
