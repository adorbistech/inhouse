import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "destructive" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-primary hover:bg-on-surface text-on-primary hover:text-surface active:translate-y-0.5",
  secondary:
    "bg-surface-container-high hover:bg-surface-container-highest text-on-surface",
  destructive:
    "bg-surface-container-high hover:bg-error hover:text-on-error text-error border border-transparent",
  ghost:
    "bg-transparent border border-outline-variant text-on-surface hover:border-primary hover:text-primary",
};

export function Button({ variant = "secondary", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      className={`font-label-md text-label-md uppercase px-space-md py-2 flex items-center justify-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
