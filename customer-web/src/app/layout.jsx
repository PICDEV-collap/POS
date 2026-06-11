import './globals.css';
import SafariViewport from './safari-viewport';

export const metadata = {
  title: 'สั่งอาหาร — POS V2',
  description: 'สั่งอาหารผ่าน QR code',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1a1a2e',
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body className="min-h-screen">
        <SafariViewport />
        {children}
      </body>
    </html>
  );
}
