import { Instrument_Sans } from "next/font/google";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans" });

export const metadata = {
  title: "A1.1.8 Transform coding",
  description: "A demonstration of lossy transform coding on audio data",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-mode="dark" className={sans.variable}>
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
