// Class helpers for the interview screens. Kept apart from ui.tsx because
// they are functions, and a file of components should export only components.

import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `text-body` is a font size from the theme. Without being told, the merge
// reads it as a text colour and drops it next to `text-ink`.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["body"] } } });

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const buttonBase =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";

const buttonVariants = {
  // Primary by inversion, and one per screen.
  primary: "bg-ink text-white hover:bg-[#343d47]",
  secondary: "border border-control text-ink hover:border-faint hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  danger: "border border-negative/50 text-negative hover:bg-negative-soft",
};

const buttonSizes = {
  sm: "h-7 px-3 text-xs",
  md: "h-8.5 px-4 text-body",
};

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md") =>
  cn(buttonBase, buttonVariants[variant], buttonSizes[size]);
