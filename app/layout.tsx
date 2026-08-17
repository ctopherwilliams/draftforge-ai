import type { Metadata } from "next";
import "./globals.css";
import "./consensus.css";
import "./draft-command.css";

export const metadata: Metadata = {
  title: "DraftForge AI — Fantasy Football Draft Coach",
  description: "A private, explainable fantasy football draft companion built for ESPN.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
