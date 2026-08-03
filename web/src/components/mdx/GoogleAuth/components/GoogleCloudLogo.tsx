/**
 * Google Cloud branding, drawn inline rather than shipped as two themed `.svg`
 * assets (the route GitAuth's GitHubLogo.tsx takes). The four-colour mark is
 * fixed — those are Google's brand colours and must not change with the theme —
 * while the "Google Cloud" wordmark paints with `currentColor`, so the header
 * needs no light/dark asset swap and the component tests need no
 * `vi.mock('@/assets/*.svg')`.
 */

/** The four-colour mark, as a bare fragment so both exports share one copy. */
function MarkPaths() {
  return (
    <>
      {/* Right arc + crossbar */}
      <path
        d="M41.32 14.00 A20 20 0 0 1 42.79 30.84 L35.28 28.10 A12 12 0 0 0 34.39 18.00 Z"
        fill="#4285F4"
      />
      <rect x="24" y="20" width="19" height="8" fill="#4285F4" />
      {/* Bottom arc */}
      <path
        d="M42.79 30.84 A20 20 0 0 1 14.00 41.32 L18.00 34.39 A12 12 0 0 0 35.28 28.10 Z"
        fill="#34A853"
      />
      {/* Left arc */}
      <path
        d="M14.00 41.32 A20 20 0 0 1 5.87 15.55 L13.12 18.93 A12 12 0 0 0 18.00 34.39 Z"
        fill="#FBBC04"
      />
      {/* Top arc */}
      <path
        d="M5.87 15.55 A20 20 0 0 1 35.47 7.62 L30.88 14.17 A12 12 0 0 0 13.12 18.93 Z"
        fill="#EA4335"
      />
    </>
  )
}

interface GoogleCloudMarkProps {
  className?: string
}

/**
 * The mark on its own, for tight spots (buttons, badges) where the wordmark
 * would not fit. Always decorative — pair it with visible text.
 */
export function GoogleCloudMark({ className = "size-4" }: GoogleCloudMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={true}
      focusable="false"
    >
      <MarkPaths />
    </svg>
  )
}

interface GoogleCloudLogoProps {
  className?: string
  ariaLabel?: string
}

/**
 * Mark + wordmark lockup for the block header. Scales from a single height
 * class (`h-6` matches the `<img>` the AwsAuth header uses).
 */
export function GoogleCloudLogo({ className = "h-6", ariaLabel = "Google Cloud" }: GoogleCloudLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 260 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...(ariaLabel
        ? { role: "img", "aria-label": ariaLabel }
        : { "aria-hidden": true, focusable: "false" })}
    >
      <MarkPaths />
      <text
        x="58"
        y="33"
        fill="currentColor"
        fontSize="26"
        fontWeight="500"
        letterSpacing="0.2"
      >
        Google Cloud
      </text>
    </svg>
  )
}
