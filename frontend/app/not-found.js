import Link from "next/link";
import { Search } from "@/components/icons";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="splash">
      <div className="empty" style={{ maxWidth: 420 }}>
        <span className="art">
          <Search size={24} />
        </span>
        <h3>That page does not exist</h3>
        <p>The link may be stale, or the campaign it pointed at has been deleted.</p>
        <Link className="btn primary" href="/campaigns" style={{ marginTop: 14 }}>
          Back to campaigns
        </Link>
      </div>
    </div>
  );
}
