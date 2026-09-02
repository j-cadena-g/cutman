import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-flag/40 bg-flag/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-flag",
        className,
      )}
      {...props}
    />
  );
}
