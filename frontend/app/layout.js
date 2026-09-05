import "./globals.css";

export const metadata = {
  title: "Email Campaigning",
  description: "Bulk email campaigns over Gmail, with reply tracking and follow-up sequences.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
