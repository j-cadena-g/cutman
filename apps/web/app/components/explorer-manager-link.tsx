import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "~/components/ui/badge";

export const EXPLORER_OPEN_ROSTER_EVENT = "cutman:open-explorer-roster";

export function ExplorerRosterLink({
  rosterId,
  className,
  children,
}: {
  rosterId: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={`#roster-${rosterId}`}
      className={className}
      onClick={() => {
        window.dispatchEvent(new CustomEvent(EXPLORER_OPEN_ROSTER_EVENT, { detail: rosterId }));
      }}
    >
      {children}
    </Link>
  );
}

export function ExplorerManagerMeta({
  displayName,
  username,
  isOwner,
  abandoned,
}: {
  displayName: string;
  username: string | null;
  isOwner: boolean;
  abandoned: boolean;
}) {
  if (abandoned) return <span>Abandoned</span>;
  const name = username ? (
    <Link
      to={`/explore/u/${encodeURIComponent(username)}`}
      className="text-link"
    >
      {displayName}
    </Link>
  ) : (
    <span>{displayName}</span>
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {name}
      {isOwner ? <Badge className="px-1.5 py-0">Commish</Badge> : null}
    </span>
  );
}
