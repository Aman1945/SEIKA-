import type { Metadata, Viewport } from "next";

import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "SEIKA — Zone Console",
  description: "Owner and staff console for a SEIKA gaming zone",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The console is used one-handed on a counter; let staff zoom if they need to.
  maximumScale: 5,
  themeColor: "#0b0e14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
