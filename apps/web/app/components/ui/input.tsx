import type { InputHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border border-cream/20 bg-ink/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flag/70",
        className,
      )}
      {...props}
    />
  );
}
