import type { ReactNode } from "react";
import { BrandNav } from "~/components/brand-nav";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerLeagueNav } from "~/components/explorer-league-nav";
import { cn } from "~/lib/utils";

export function ExplorerPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={cn("mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8", className)}>
      <BrandNav />
      {children}
    </main>
  );
}

export function ExplorerLeagueChrome({
  avatarUrl,
  name,
  eyebrow,
  meta,
  leagueId,
  trailing,
}: {
  avatarUrl: string | null;
  name: string;
  eyebrow: string;
  meta: string;
  leagueId: string;
  trailing?: ReactNode;
}) {
  return (
    <header className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex min-w-0 items-center gap-4">
        <ExplorerAvatar src={avatarUrl} name={name} size="lg" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{eyebrow}</p>
          <h1 className="truncate font-display text-3xl leading-tight md:text-4xl">{name}</h1>
          <p className="mt-1 text-sm text-muted">{meta}</p>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3 lg:items-end">
        <ExplorerLeagueNav leagueId={leagueId} />
        {trailing}
      </div>
    </header>
  );
}
