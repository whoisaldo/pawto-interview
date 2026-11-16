// The interview screens' one vocabulary of parts. Selection is always the same
// thin accent line under a label, whether it marks a tab, a nav item or a
// choice, so colour elsewhere is free to mean a status.

import { useState } from "react";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Tabs } from "@base-ui/react/tabs";
import { Check, Copy } from "lucide-react";
import type { AiPolicy, SessionStatus } from "./api";
import { buttonClass, cn } from "./classes";
import type { ButtonSize, ButtonVariant } from "./classes";
import { STATUS_WORDS, copyText } from "./format";

// Buttons

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = ({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonProps) => (
  <button type={type} className={cn(buttonClass(variant, size), className)} {...rest} />
);

/** A button that is only an icon. The label is what a screen reader says. */
export const IconButton = ({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={cn(
      "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

// Pills: a pale tint with text of the same hue. One per row.

const pillTones = {
  neutral: "bg-raised text-muted",
  positive: "bg-positive-soft text-positive",
  negative: "bg-negative-soft text-negative",
  warning: "bg-warning-soft text-warning",
};

export const Pill = ({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof pillTones;
  className?: string;
  children: ReactNode;
}) => (
  <span
    className={cn(
      "inline-flex h-5.5 flex-none items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
      pillTones[tone],
      className,
    )}
  >
    {children}
  </span>
);

const STATUS_TONE: Record<SessionStatus, keyof typeof pillTones> = {
  scheduled: "neutral",
  running: "positive",
  paused: "warning",
  ended: "neutral",
};

export const StatusPill = ({ status }: { status: SessionStatus }) => (
  <Pill tone={STATUS_TONE[status]}>{STATUS_WORDS[status]}</Pill>
);

/** Whether AI is allowed in a session. Said in words wherever a session is shown. */
export const AiPill = ({ policy, className }: { policy: AiPolicy; className?: string }) => (
  <Pill className={cn(policy === "allowed" && "text-ink", className)}>
    <span
      aria-hidden
      className={cn("size-1.5 rounded-full", policy === "allowed" ? "bg-accent" : "border border-faint")}
    />
    {policy === "allowed" ? "AI allowed" : "AI off"}
  </Pill>
);

export const SampleTag = () => <Pill>Sample</Pill>;

// Text in the figure face: clocks, counts, ids, code.
export const Figure = ({ className, children }: { className?: string; children: ReactNode }) => (
  <span className={cn("font-figure tabular-nums", className)}>{children}</span>
);

// Surfaces

export const Panel = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section className={cn("rounded-md border border-line bg-surface", className)}>{children}</section>
);

export const PanelHeader = ({
  title,
  detail,
  actions,
}: {
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-5 py-2.5 sm:flex-nowrap">
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 className="text-base font-semibold text-balance text-ink">{title}</h2>
      {detail && <span className="text-xs text-faint">{detail}</span>}
    </div>
    {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const PageHeader = ({
  title,
  finding,
  actions,
}: {
  title: ReactNode;
  /** One sentence about the data, never about the interface. */
  finding?: ReactNode;
  actions?: ReactNode;
}) => (
  <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold text-balance text-ink">{title}</h1>
      {finding && <p className="mt-1.5 text-sm text-pretty text-muted">{finding}</p>}
    </div>
    {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
  </header>
);

// States

/** An empty block keeps its frame and says the one thing to do next. */
export const Empty = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-body text-muted">
    <p className="text-pretty">{children}</p>
    {action}
  </div>
);

/** An error, in the block that failed, with a way to try again. */
export const Failure = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-body">
    <p className="text-pretty text-negative">{message}</p>
    {onRetry && (
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);

/** A message beside the control it is about. */
export const Note = ({
  tone = "muted",
  className,
  children,
}: {
  tone?: "muted" | "negative" | "positive" | "warning";
  className?: string;
  children: ReactNode;
}) => (
  <p
    role={tone === "negative" ? "alert" : undefined}
    className={cn(
      "text-xs text-pretty",
      { muted: "text-faint", negative: "text-negative", positive: "text-positive", warning: "text-warning" }[tone],
      className,
    )}
  >
    {children}
  </p>
);

/** Loading: the block at its real size with flat bars where values will be. */
export const SkeletonRows = ({ rows = 3 }: { rows?: number }) => (
  <div aria-busy="true" aria-label="Loading" className="divide-y divide-rule">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="flex h-10.5 items-center gap-6 px-5">
        <span className="h-3 w-48 rounded-sm bg-raised" />
        <span className="h-3 w-24 rounded-sm bg-raised" />
        <span className="ml-auto h-3 w-16 rounded-sm bg-raised" />
      </div>
    ))}
  </div>
);

// Tables: rules and alignment, grey sentence-case headers, numbers to the right.

export const tableClass = "w-full border-collapse text-body";
export const thClass = "h-9 px-3 text-left text-xs font-normal whitespace-nowrap text-faint first:pl-5 last:pr-5";
export const tdClass = "h-10.5 border-t border-rule px-3 align-middle first:pl-5 last:pr-5";
export const numClass = "text-right font-figure tabular-nums";

// Forms

export const fieldClass =
  "block w-full rounded-md border border-control bg-ground px-3 text-body text-ink placeholder:text-faint hover:border-faint disabled:cursor-not-allowed disabled:opacity-60";
export const inputClass = `${fieldClass} h-8.5`;
export const textareaClass = `${fieldClass} py-2 leading-5`;

export const Field = ({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) => (
  <div className={cn("space-y-1.5", className)}>
    <label htmlFor={htmlFor} className="block text-body font-medium text-ink">
      {label}
    </label>
    {children}
    {error ? <Note tone="negative">{error}</Note> : hint ? <Note>{hint}</Note> : null}
  </div>
);

/**
 * A choice among a few, as native radios. The chosen one is marked by the
 * accent line under its label and nothing else.
 */
export const Choice = <T extends string | number>({
  name,
  legend,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  name: string;
  legend: string;
  value: T | null;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) => (
  <fieldset className={cn("flex flex-wrap gap-x-1 gap-y-1", className)} disabled={disabled}>
    <legend className="sr-only">{legend}</legend>
    {options.map((option) => {
      const chosen = option.value === value;
      return (
        <label
          key={String(option.value)}
          title={option.hint}
          className={cn(
            "relative cursor-pointer rounded-sm px-2.5 py-1.5 text-body has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent has-disabled:cursor-not-allowed has-disabled:opacity-50",
            chosen ? "text-ink" : "text-muted hover:text-ink",
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={chosen}
            onChange={() => onChange(option.value)}
          />
          <span
            className={cn(
              "border-b pb-1",
              chosen ? "border-accent font-medium" : "border-transparent",
            )}
          >
            {option.label}
          </span>
        </label>
      );
    })}
  </fieldset>
);

// Tabs: underline tabs on a full-width rule.

export const TabList = ({ children, className }: { children: ReactNode; className?: string }) => (
  <Tabs.List className={cn("relative flex gap-5 overflow-x-auto border-b border-line px-5", className)}>
    {children}
  </Tabs.List>
);

export const Tab = ({ value, children }: { value: string; children: ReactNode }) => (
  <Tabs.Tab
    value={value}
    className="group -mb-px flex h-10 flex-none items-center text-body whitespace-nowrap text-muted hover:text-ink data-active:text-ink"
  >
    <span className="flex h-full items-center gap-1.5 border-b border-transparent group-data-active:border-accent group-data-active:font-medium">
      {children}
    </span>
  </Tabs.Tab>
);

export const TabRoot = (props: ComponentProps<typeof Tabs.Root>) => <Tabs.Root {...props} />;
export const TabPanel = (props: ComponentProps<typeof Tabs.Panel>) => <Tabs.Panel {...props} />;

/** A small count beside a label, for a queue that needs someone. */
export const Count = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-raised px-1.5 text-xs font-medium text-ink tabular-nums">{children}</span>
);

// A read-only value joined to the button that copies it.

export const CopyField = ({ label, value }: { label: string; value: string }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    setState((await copyText(value)) ? "copied" : "failed");
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <div>
      <div className="flex">
        <input
          readOnly
          aria-label={label}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={cn(inputClass, "min-w-0 flex-1 rounded-r-none border-r-0 font-figure text-xs")}
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-8.5 flex-none items-center gap-1.5 rounded-r-md border border-control px-3 text-body font-medium text-ink hover:border-faint hover:bg-raised"
        >
          {state === "copied" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {state === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {state === "failed" && (
        <Note tone="negative" className="mt-1">
          Could not copy. Select the link and copy it by hand.
        </Note>
      )}
    </div>
  );
};

/**
 * A button for something that cannot be taken back. It opens a dialog that
 * names what will happen, and only the dialog's button does it.
 */
export const ConfirmButton = ({
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
  variant = "danger",
  size = "md",
  disabled,
}: {
  label: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
}) => (
  <AlertDialog.Root>
    <AlertDialog.Trigger disabled={disabled} className={buttonClass(variant, size)}>
      {label}
    </AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/60" />
      <AlertDialog.Popup className="console fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-surface p-5 shadow-xl">
        <AlertDialog.Title className="text-base font-semibold text-balance text-ink">{title}</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-body text-pretty text-muted">
          {description}
        </AlertDialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialog.Close className={buttonClass("ghost")}>Cancel</AlertDialog.Close>
          <AlertDialog.Close className={buttonClass("danger")} onClick={() => void onConfirm()}>
            {confirmLabel}
          </AlertDialog.Close>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>
);

/** Program text or output, as it was printed. */
export const Pre = ({ className, children }: { className?: string; children: ReactNode }) => (
  <pre
    className={cn(
      "overflow-x-auto rounded-md border border-line bg-ground px-3 py-2 font-figure text-body whitespace-pre-wrap text-ink",
      className,
    )}
  >
    {children}
  </pre>
);
