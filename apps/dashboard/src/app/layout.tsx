import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Russo_One } from "next/font/google";

import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { Shell } from "@/components/Shell";

/*
 * Self-hosted at build time rather than fetched from Google: no runtime
 * request, no flash of unstyled text, and a zone on a flaky connection still
 * gets its own typeface.
 *
 * Chakra Petch carries the interface — squared-off and technical without
 * costing legibility in a dense table. Russo One is display only: the brand,
 * headings and the big numbers. It is a loud face and a cashier reads this
 * screen all shift, so it never touches body copy.
 */
const ui = Chakra_Petch({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const display = Russo_One({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SEIKA — Zone Console",
  description: "Owner and staff console for a SEIKA gaming zone",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The console is used one-handed on a counter; let staff zoom if they need to.
  maximumScale: 5,
  themeColor: "#080a12",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable}`}>
      <body>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
