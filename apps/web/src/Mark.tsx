/**
 * The Silvic mark: one trunk, three plotted nodes. Drawn as survey linework so
 * it sits inside the same visual language as the grove canvas.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 21.5V14.25M12 14.25V10.5M12 14.25 6.75 10.5M12 14.25 17.25 10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.75" cy="9" r="1.9" fill="currentColor" />
      <circle cx="12" cy="9" r="1.9" fill="currentColor" />
      <circle cx="17.25" cy="9" r="1.9" fill="currentColor" />
      <path
        d="M3.25 21.5h17.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}
