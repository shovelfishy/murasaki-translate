import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "outline" | "destructive" | "ghost";
type ButtonSize = "default" | "sm" | "lg" | "icon";

function buttonVariants({
  variant = "default",
  size = "default",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const base =
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

  const variantClasses: Record<ButtonVariant, string> = {
    default: "bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)]",
    secondary: "bg-[var(--surface-soft)] text-[var(--fg)] hover:border-[var(--accent)] border border-[var(--border)]",
    outline: "border border-[var(--accent)] text-[var(--accent)] bg-transparent hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
    destructive: "bg-[var(--danger)] text-white hover:opacity-90",
    ghost: "text-[var(--fg)] border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]",
  };

  const sizeClasses: Record<ButtonSize, string> = {
    default: "h-10 px-4 py-2",
    sm: "h-9 px-3",
    lg: "h-11 px-6",
    icon: "h-10 w-10",
  };

  return cn(base, variantClasses[variant], sizeClasses[size]);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} type={type} {...props} />;
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };

