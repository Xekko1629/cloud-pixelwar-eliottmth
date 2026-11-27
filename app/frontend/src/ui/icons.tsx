import type { SVGProps } from 'react';

// Inline SVG icons: no icon font, no request to a third party (the CSP allows neither).
// Stroke icons on a 24 × 24 grid, drawn with currentColor; decorative unless labelled.

type IconProps = SVGProps<SVGSVGElement>;

function Stroke({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Inspect: the arrow of a pointer. */
export const PointerIcon = (props: IconProps) => (
  <Stroke {...props}><path d="M5 3l14 7-6 2-2 6z" /><path d="M13 13l5 5" /></Stroke>
);

/** Brush: a paintbrush with its stroke. */
export const BrushIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z" />
    <path d="M9 13.5c-2.2 0-4 1.8-4 4 0 1.4-.8 2.5-2 3 4 1 9-.5 9-4" />
  </Stroke>
);

/** Frame everything: four corners. */
export const FrameIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </Stroke>
);

export const EyeIcon = (props: IconProps) => (
  <Stroke {...props}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Stroke>
);

export const EyeOffIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.7 3.6M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
  </Stroke>
);

export const UserIcon = (props: IconProps) => (
  <Stroke {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Stroke>
);

export const LogOutIcon = (props: IconProps) => (
  <Stroke {...props}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Stroke>
);

export const SquareIcon = (props: IconProps) => (
  <Stroke {...props}><rect x="5" y="5" width="14" height="14" rx="1.5" /></Stroke>
);

export const CircleIcon = (props: IconProps) => (
  <Stroke {...props}><circle cx="12" cy="12" r="7.5" /></Stroke>
);

/** Discord mark, for "Se connecter avec Discord" (brand guidelines: the mark beside the name). */
export const DiscordIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.86-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .09-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.88.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.23 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z" />
  </svg>
);

/** Logo: four pixels of the palette. */
export const LogoMark = (props: IconProps) => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" {...props}>
    <rect x="2" y="2" width="9.5" height="9.5" rx="2" fill="#E50000" />
    <rect x="12.5" y="2" width="9.5" height="9.5" rx="2" fill="#E59500" />
    <rect x="2" y="12.5" width="9.5" height="9.5" rx="2" fill="#0083C7" />
    <rect x="12.5" y="12.5" width="9.5" height="9.5" rx="2" fill="#02BE01" />
  </svg>
);
