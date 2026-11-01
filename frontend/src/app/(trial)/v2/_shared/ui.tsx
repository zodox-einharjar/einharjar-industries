'use client'

// Small controls shared across trial pages.

export function Switch({ on, onChange, label, children, disabled }: {
  on: boolean; onChange?: (v: boolean) => void; label: string; children?: React.ReactNode; disabled?: boolean
}) {
  return (
    <label className={`v2-switch${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={e => onChange?.(e.target.checked)} />
      <span className="track" aria-hidden><span className="knob" /></span>
      <span className="text">
        <span className="label">{label}</span>
        {children && <span className="hint">{children}</span>}
      </span>
    </label>
  )
}
