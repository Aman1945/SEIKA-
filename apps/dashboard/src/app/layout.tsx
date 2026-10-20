import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { Shell } from "@/components/Shell";

/*
 * Self-hosted at build time: no runtime request, no flash of unstyled text,
 * and a zone on a flaky connection still gets its own typeface.
 *
 * Inter carries the interface — it was drawn for screens at small sizes, which
 * is most of what a console is. JetBrains Mono is for numbers only: timers,
 * money, PC codes. Its figures are tabular, so a running clock does not shift
 * sideways as the digits change, and a column of prices lines up on its own.
 */
const ui = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
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
  themeColor: "#0a0b0d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
