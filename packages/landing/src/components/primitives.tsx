import type { ReactNode } from "react";
import { motion, type Variants } from "framer-motion";

/* ------------------------------------------------------------------ */
/* Motion helpers                                                       */
/* ------------------------------------------------------------------ */

const EASE = [0.16, 1, 0.3, 1] as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 26 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: EASE },
  },
};

export const stagger: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.09, delayChildren: 0.05 },
  },
};

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  once?: boolean;
};

/** Fades + lifts content into view on scroll. */
export function Reveal({ children, className, delay = 0, y = 26, once = true }: RevealProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Brand mark                                                           */
/* ------------------------------------------------------------------ */

export function OrbitMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="orbit-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f72f0" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <path
        fill="url(#orbit-grad)"
        d="M16 4a12 12 0 1 0 12 12h-3.4A8.6 8.6 0 1 1 16 7.4V4z"
      />
      <circle cx="16" cy="16" r="3.6" fill="#fff" />
      <circle cx="16" cy="16" r="3.6" fill="url(#orbit-grad)" opacity="0.35" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Pills, tags, buttons                                                 */
/* ------------------------------------------------------------------ */

type TagProps = {
  children: ReactNode;
  className?: string;
  tone?: "brand" | "terra" | "neutral";
  icon?: ReactNode;
};

export function Tag({ children, className = "", tone = "brand", icon }: TagProps) {
  const tones = {
    brand:
      "text-brand-200 border-brand-500/30 bg-brand-500/10 shadow-[0_0_30px_-12px_var(--color-brand-500)]",
    terra:
      "text-emerald-200 border-emerald-400/30 bg-emerald-400/10 shadow-[0_0_30px_-12px_var(--color-emerald-glow)]",
    neutral: "text-white/70 border-white/12 bg-white/5",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium tracking-wide ${tones[tone]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}

type ButtonProps = {
  children: ReactNode;
  href?: string;
  variant?: "primary" | "ghost" | "terra";
  className?: string;
  icon?: ReactNode;
};

export function Button({ children, href = "#", variant = "primary", className = "", icon }: ButtonProps) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-all duration-300 active:scale-[0.98]";
  const variants = {
    primary:
      "text-white bg-gradient-to-r from-brand-500 to-fuchsia-600 shadow-[0_14px_44px_-14px_var(--color-brand-500)] hover:shadow-[0_20px_60px_-12px_var(--color-fuchsia-glow)] hover:-translate-y-0.5",
    terra:
      "text-emerald-50 bg-gradient-to-r from-emerald-500 to-cyan-500 shadow-[0_14px_44px_-14px_var(--color-emerald-glow)] hover:-translate-y-0.5",
    ghost:
      "text-white/85 glass hover:text-white hover:border-white/25 hover:-translate-y-0.5",
  } as const;
  return (
    <a href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
      {icon}
    </a>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
  tone = "brand",
}: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "center" | "left";
  tone?: "brand" | "terra";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <Reveal>
        <Tag tone={tone}>{eyebrow}</Tag>
      </Reveal>
      <Reveal delay={0.06}>
        <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
          {title}
        </h2>
      </Reveal>
      {subtitle && (
        <Reveal delay={0.12}>
          <p className="mt-5 text-base leading-relaxed text-white/60 sm:text-lg">{subtitle}</p>
        </Reveal>
      )}
    </div>
  );
}
