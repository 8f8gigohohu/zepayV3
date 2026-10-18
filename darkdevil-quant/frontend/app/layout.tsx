import "./globals.css";
import Shell from "@/components/Shell";

export const metadata = {
  title: "DarkDevil Quant",
  description: "Multi-exchange crypto trading terminal with provenance-labelled market data",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
