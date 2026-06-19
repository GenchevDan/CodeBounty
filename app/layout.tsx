import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeBounty — pay $0.50–2 USDC, get your bug fixed",
  description:
    "Post a small bug or TODO and escrow a $0.50–2 USDC bounty. Fixers compete PR-style; you accept exactly one and the contract pays them the whole bounty instantly — winner-take-all, no stiffing. Agents can submit fixes over x402. On ARC.",
  keywords: "CodeBounty, ARC, USDC, bounty, escrow, code review, PR, x402, micropayments, agents, agentic commerce",
};

export const viewport: Viewport = { themeColor: "#f4efe4" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
