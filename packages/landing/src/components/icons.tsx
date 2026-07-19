import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps): IconProps => ({
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  ...props,
});

export const Play = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const Pause = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const Scissors = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M8.2 7.6 20 18M8.2 16.4 20 6M11.6 12l-1.4 1" />
  </svg>
);

export const FastForward = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 6.5v11l8-5.5z" fill="currentColor" stroke="none" />
    <path d="M12 6.5v11l8-5.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const Eye = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const Link = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 6.5 12.5 5a4 4 0 0 1 6 6l-1.5 1.5" />
    <path d="M13 17.5 11.5 19a4 4 0 0 1-6-6L7 11.5" />
  </svg>
);

export const Box = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 8.5v7a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4a2 2 0 0 1-1-1.7v-7a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.7Z" />
    <path d="M3.3 7 12 12l8.7-5M12 22V12" />
  </svg>
);

export const Flag = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 21V4M5 4h11l-1.6 3.5L16 11H5" />
  </svg>
);

export const Sparkles = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9 12 3.5Z" />
    <path d="M19 4v3M20.5 5.5h-3M5 17v2.5M6.2 18.2H3.8" />
  </svg>
);

export const Lock = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const Layers = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 21 8l-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
  </svg>
);

export const Cpu = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M10 10.5h4v3h-4z" fill="currentColor" stroke="none" />
    <path d="M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21" />
  </svg>
);

export const Terminal = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </svg>
);

export const ArrowRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const Check = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const Bolt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" stroke="none" />
  </svg>
);

export const Github = (p: IconProps) => (
  <svg {...base(p)}>
    <path
      d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.65-.2.65-.45v-1.7c-2.6.57-3.15-1.1-3.15-1.1-.43-1.1-1.05-1.4-1.05-1.4-.85-.6.07-.58.07-.58.95.07 1.45.98 1.45.98.84 1.44 2.2 1.02 2.74.78.08-.6.33-1.02.6-1.26-2.08-.24-4.27-1.04-4.27-4.64 0-1.02.37-1.86.97-2.51-.1-.24-.42-1.2.09-2.5 0 0 .79-.25 2.6.96a9 9 0 0 1 4.7 0c1.8-1.2 2.6-.96 2.6-.96.5 1.3.18 2.26.09 2.5.6.65.96 1.49.96 2.5 0 3.6-2.2 4.4-4.28 4.63.34.3.64.86.64 1.74v2.58c0 .26.16.56.65.46A9.5 9.5 0 0 0 12 2.5Z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

export const Cursor = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 3.5 19 11l-5.8 1.7L10.5 19 5 3.5Z" fill="currentColor" stroke="none" />
  </svg>
);

export const Compass = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" fill="currentColor" stroke="none" />
  </svg>
);

export const Code = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
  </svg>
);

export const GitBranch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="7" r="2.4" />
    <path d="M6 8.4v7.2M18 9.4c0 4-4 3.6-7 4.6" />
  </svg>
);
