export function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 2.5 21 8v8l-9 5.5L3 16V8l9-5.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M12 2.5v19M3 8l9 5.5 9-5.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.55" />
      <path d="M12 13.5 21 8" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
    </svg>
  )
}
