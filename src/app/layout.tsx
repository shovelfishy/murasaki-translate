import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const fraunces = localFont({
  src: [
    {
      path: "../../public/fonts/Fraunces-VariableFont_SOFT,WONK,opsz,wght.ttf",
      style: "normal",
    },
    {
      path: "../../public/fonts/Fraunces-Italic-VariableFont_SOFT,WONK,opsz,wght.ttf",
      style: "italic",
    },
  ],
  variable: "--font-display",
});

const sourceSans3 = localFont({
  src: [
    {
      path: "../../public/fonts/SourceSans3-VariableFont_wght.ttf",
      style: "normal",
    },
    {
      path: "../../public/fonts/SourceSans3-Italic-VariableFont_wght.ttf",
      style: "italic",
    },
  ],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Murasaki Translate",
  description: "Continuous speech translation with cut-on-demand controls.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sourceSans3.variable} ${fraunces.variable} antialiased`}>{children}</body>
    </html>
  );
}
