import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

const badgeVariants = cva("eyebrow-sm inline-flex items-center rounded-full border px-2.5 py-0.5", {
  variants: {
    variant: {
      default: "border-flag/40 bg-flag/10 text-flag",
      neutral: "border-cream/15 bg-cream/5 text-muted",
      warning: "border-danger/40 bg-danger/10 text-danger",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
