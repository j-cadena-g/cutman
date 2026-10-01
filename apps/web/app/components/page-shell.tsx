import type { HTMLAttributes, ReactNode } from "react";
import { BrandNav } from "~/components/brand-nav";
import { cn } from "~/lib/utils";

const GUTTER = "px-4 sm:px-6 lg:px-8";

const WIDTH = {
  narrow: "max-w-2xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

// Every signed-in page: a full-width top bar that stays put across routes (so the nav never
// moves), then the page body at one of three widths with shared gutters and bottom padding.
export function PageShell({
  width = "narrow",
  actions,
  className,
  children,
}: {
  width?: keyof typeof WIDTH;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <header
        className={cn("mx-auto flex min-h-16 w-full max-w-7xl flex-wrap items-center justify-between gap-3 pt-4", GUTTER)}
      >
        <BrandNav />
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </header>
      <main className={cn("mx-auto w-full pb-16 pt-6", WIDTH[width], GUTTER, className)}>{children}</main>
    </>
  );
}

export function PageTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cn("font-display text-3xl leading-tight md:text-4xl", className)} {...props} />;
}

export function PageLead({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-2 text-muted", className)} {...props} />;
}

export function SectionHeading({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("eyebrow text-muted", className)} {...props} />;
}
