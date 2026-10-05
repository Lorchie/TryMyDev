/** The TryMyDev mark: a play button with a Git branch cut out of it, in the text colour it is given. */
export function Mark({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="mark">
      <mask id="mark-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#fff" />
        <path d="M36 38 V62 M36 45 Q36 50 44 50 H50" fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round" />
        <circle cx="36" cy="38" r="5" />
        <circle cx="36" cy="62" r="5" />
        <circle cx="53" cy="50" r="5.5" />
      </mask>
      <path
        mask="url(#mark-cut)"
        d="M28 24 L74 50 L28 76 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinejoin="round"
      />
    </svg>
  )
}
