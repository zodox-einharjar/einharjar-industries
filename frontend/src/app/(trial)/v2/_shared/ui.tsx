'use client'

import { useState } from 'react'

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

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
  } else {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(el)
    el.focus(); el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  }
}

export function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={primary ? 'v2-btn primary' : 'v2-btn'}
      disabled={!text}
      onClick={async () => { await copyText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}
