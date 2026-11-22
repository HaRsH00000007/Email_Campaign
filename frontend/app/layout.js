import "./globals.css";
import { ToastProvider } from "@/components/ui";

export const metadata = {
  title: {
    default: "Pulse — Email Campaigns",
    template: "%s · Pulse",
  },
  description:
    "Bulk email campaigns over Gmail, with reply tracking, follow-up sequences and per-mailbox pacing.",
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#080a11" },
  ],
};

// Runs before paint so the stored theme is applied without a flash of the
// wrong palette. Kept tiny and dependency-free on purpose.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('ec_theme');if(!t||t==='system'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Loaded over the network with a full system-font fallback in the CSS,
            so the app still renders correctly on an air-gapped install. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400..750&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
