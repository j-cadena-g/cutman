import { Link } from "react-router";

export function BrandNav({ exploreActive = false }: { exploreActive?: boolean }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">
      <Link to="/">Cutman</Link>
      <span className="mx-2 text-cream/30">/</span>
      <Link to="/explore" className={exploreActive ? "text-cream" : undefined}>
        Explore Sleeper
      </Link>
    </p>
  );
}
