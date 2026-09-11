import { Link, useLocation } from "react-router";

export function BrandNav() {
  const { pathname } = useLocation();
  const homeActive = pathname === "/";
  const exploreActive = pathname === "/explore" || pathname.startsWith("/explore/");

  return (
    <nav
      aria-label="Primary"
      className="text-xs font-semibold uppercase tracking-[0.24em] text-flag"
    >
      <Link to="/" aria-current={homeActive ? "page" : undefined}>
        Cutman
      </Link>
      <span className="mx-2 text-cream/30" aria-hidden="true">/</span>
      <Link
        to="/explore"
        className={exploreActive ? "text-cream" : undefined}
        aria-current={exploreActive ? "page" : undefined}
      >
        Explore Sleeper
      </Link>
    </nav>
  );
}
