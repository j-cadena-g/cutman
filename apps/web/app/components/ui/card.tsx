import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

// The one panel look. `Card` adds default padding; list-shaped panels (standings, drafts,
// matchups) apply `surface` to their own element and pad their rows instead.
export const surface = "rounded-2xl border border-cream/12 bg-field/80 shadow-card";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(surface, "p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("font-display text-2xl text-cream", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-sm text-muted", className)} {...props} />;
}

// Section-level "nothing here" state. Smaller title than a full card so it reads as secondary.
export function EmptyState({ title, detail, className }: { title: string; detail: string; className?: string }) {
  return (
    <Card className={className}>
      <CardTitle className="text-lg">{title}</CardTitle>
      <CardDescription>{detail}</CardDescription>
    </Card>
  );
}
