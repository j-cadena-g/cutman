import { cn } from "~/lib/utils";

const SIZE_CLASS = {
  sm: "h-8 w-8 text-[10px]",
  md: "h-11 w-11 text-sm",
  lg: "h-14 w-14 text-lg",
} as const;

type ExplorerAvatarSize = keyof typeof SIZE_CLASS;

export function ExplorerAvatar({
  src,
  name,
  size = "md",
  className,
}: {
  src: string | null | undefined;
  name: string;
  size?: ExplorerAvatarSize;
  className?: string;
}) {
  const fallback = name.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full bg-turf font-semibold text-cream",
        SIZE_CLASS[size],
        className,
      )}
    >
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        {fallback}
      </span>
      {src ? (
        <img
          src={src}
          alt=""
          className="relative z-10 h-full w-full object-cover"
          onLoad={(event) => {
            event.currentTarget.style.display = "";
          }}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}
