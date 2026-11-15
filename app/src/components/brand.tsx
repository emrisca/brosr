// The note graph from the app icon, drawn at the small size the shell uses.
// A fixed dark base keeps it readable in light and in dark mode.
export function Brand({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="6.8" fill="#2c2c2e" />
      <g
        stroke="#ffffff"
        strokeOpacity="0.45"
        strokeWidth="0.3"
        strokeLinecap="round"
      >
        <path d="M16 16 L9.4 10.2" />
        <path d="M16 16 L23 11.1" />
        <path d="M16 16 L9.1 20.9" />
        <path d="M16 16 L23.6 21.4" />
        <path d="M16 16 L16 7.3" />
        <path d="M16 16 L14.4 25.2" />
        <path d="M9.4 10.2 L16 7.3" />
        <path d="M23 11.1 L23.6 21.4" />
        <path d="M9.1 20.9 L14.4 25.2" />
      </g>
      <g fill="#ffffff" fillOpacity="0.92">
        <circle cx="9.4" cy="10.2" r="0.95" />
        <circle cx="23" cy="11.1" r="1.09" />
        <circle cx="9.1" cy="20.9" r="0.8" />
        <circle cx="23.6" cy="21.4" r="0.95" />
        <circle cx="16" cy="7.3" r="0.73" />
        <circle cx="14.4" cy="25.2" r="0.8" />
      </g>
      <circle cx="16" cy="16" r="1.67" fill="#ffffff" />
    </svg>
  );
}
