import { Link, useLocation } from "react-router";
import { cn } from "~/lib/utils";

export function BrandNav() {
  const { pathname } = useLocation();
  const homeActive = pathname === "/";
  const exploreActive = pathname === "/explore" || pathname.startsWith("/explore/");

  return (
    <nav aria-label="Primary" className="eyebrow tracking-brand text-flag">
      <Link to="/" aria-current={homeActive ? "page" : undefined} className="rounded-sm focus-ring">
        Cutman
      </Link>
      <span className="mx-2 text-cream/30" aria-hidden="true">/</span>
      <Link
        to="/explore"
        className={cn("rounded-sm transition-colors focus-ring", exploreActive ? "text-cream" : "hover:text-cream")}
        aria-current={exploreActive ? "page" : undefined}
      >
        Explore Sleeper
      </Link>
    </nav>
  );
}
