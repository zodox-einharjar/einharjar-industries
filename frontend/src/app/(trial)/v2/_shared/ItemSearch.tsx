'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'

interface Hit { type_id: number; name: string; group: string }

/** Top-bar item search: type a name, pick a match, land on that item's page.
 *  "/" focuses it from anywhere on the page. */
export function ItemSearch() {
  const router = useRouter()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (e.key !== '/' || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setHits([]); return }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/items/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then(r => (r.ok ? r.json() : []))
        .then((h: Hit[]) => { setHits(h); setActive(0); setOpen(true) })
        .catch(() => {})
    }, 150)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  function go(h: Hit | undefined) {
    if (!h) return
    setOpen(false); setQ(''); setHits([])
    inputRef.current?.blur()
    router.push(`/v2/items/${h.type_id}`)
  }

  const showList = open && hits.length > 0

  return (
    <div className="v2-finder">
      <input
        ref={inputRef}
        type="search"
        placeholder="Find an item…  /"
        aria-label="Find an item"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]) }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
        }}
      />
      {showList && (
        <ul id={listId} role="listbox" className="v2-finder-list">
          {hits.map((h, i) => (
            <li
              key={h.type_id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); go(h) }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{h.name}</span>
              <small>{h.group}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
