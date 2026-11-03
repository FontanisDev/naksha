import type { Metadata } from "next";
import { Inter } from "next/font/google";
/* Task 92 — JetBrains Mono is VENDORED (public/fonts/) and loaded via
   next/font/local: the next/font/google module for this font started
   failing Turbopack's resolver ("queries have exactly one entry")
   mid-day — Google's serving shape for the variable file moved under
   us, and the same code that compiled at 17:35 500-ed at 18:35. A
   vendored file is immune to Google-side changes and offline-safe.
   Inter still rides next/font/google (its module resolves fine). */
import localJetBrains from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// Programmer-grade typography:
//   Inter for UI — clean, optimized for screen reading at small sizes
//   JetBrains Mono for terminal/code — ligature-free, true monospace
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
});

const jetbrainsMono = localJetBrains({
  src: "../../public/fonts/jetbrains-mono-variable-latin.woff2",
  variable: "--font-jetbrains-mono",
  display: "swap",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "Naksha — Terminal · Map · CareSpace",
  description:
    "A geographic shell: terminal-driven workspace with an interactive map, a virtual file system, and a Trillium-inspired hierarchical thought tree. Warm glassmorphism, optimized for low idle CPU.",
  keywords: [
    "Naksha",
    "geographic shell",
    "terminal workspace",
    "Leaflet",
    "CareSpace",
    "Trillium",
    "tree map",
    "knowledge management",
  ],
  authors: [{ name: "Naksha" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Naksha — Geographic Shell",
    description: "Terminal · Map · CareSpace — one view, one flow, one mind.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body
        className="antialiased"
        style={{
          fontFamily: "var(--font-inter), system-ui, sans-serif",
        }}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
