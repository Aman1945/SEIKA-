import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Russo_One } from "next/font/google";

import "./globals.css";
import { PlayerProvider } from "@/lib/session";
import { AppShell } from "@/components/AppShell";

/*
 * Self-hosted at build time: no runtime request to Google, no flash of
 * unstyled text, and a player on a zone's flaky wifi still gets the typeface.
 *
 * Russo One is display only — the brand, the level number, the session clock.
 * It is a loud face, so it never carries body copy.
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
  title: "SEIKA",
  description: "Your gaming passport — wallet, sessions, XP and rewards",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "SEIKA" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0a0b1a",
  // Installed to a home screen, the app should reach under the notch and the
  // home indicator; the stylesheet pads for both with env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable}`}>
      <body>
        <PlayerProvider>
          <AppShell>{children}</AppShell>
        </PlayerProvider>
      </body>
    </html>
  );
}
