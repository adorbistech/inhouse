interface ChipProps {
  children: React.ReactNode;
  tone?: "neutral" | "primary" | "secondary" | "tertiary" | "error";
  className?: string;
}

const TONE_TEXT: Record<NonNullable<ChipProps["tone"]>, string> = {
  neutral: "text-on-surface-variant",
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
  error: "text-error",
};

export function Chip({ children, tone = "neutral", className = "" }: ChipProps) {
  return (
    <span
      className={`bg-surface-container-high font-code-dense text-code-dense px-space-xs py-0.5 uppercase inline-flex items-center ${TONE_TEXT[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
