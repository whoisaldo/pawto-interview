import type { ReactNode } from "react";

/** The product's mark and name. The mascot carries the brand; the name is in the app's own face. */
export const Brand = ({ scope }: { scope?: string }) => (
  <span className="flex items-center gap-2.5">
    <img src="/mascot.png" alt="" className="pixelated size-7" />
    <span className="flex flex-col leading-none">
      <span className="text-base leading-none font-semibold text-ink">PawtoInterview</span>
      {scope && <span className="mt-1 text-xs text-faint">{scope}</span>}
    </span>
  </span>
);

/** A whole-screen state: loading a seat, a dead link, no access. */
export const FullScreenNotice = ({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) => (
  <main className="console flex min-h-dvh items-center justify-center p-4">
    <div className="w-full max-w-sm rounded-md border border-line bg-surface p-6">
      <Brand />
      <h1 className="mt-6 text-xl font-semibold text-balance text-ink">{title}</h1>
      {detail && <p className="mt-1.5 text-body text-pretty text-muted">{detail}</p>}
      {children && <div className="mt-5 flex flex-wrap gap-2">{children}</div>}
    </div>
  </main>
);
