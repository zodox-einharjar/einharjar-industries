'use client'

import { useState } from 'react'

// Sortable table headers shared by trial pages. A null key means "the order the server sent".

export type SortDir = 'asc' | 'desc'

export function useSort<K extends string>(initial: K | null, initialDir: SortDir = 'desc') {
  const [key, setKey] = useState<K | null>(initial)
  const [dir, setDir] = useState<SortDir>(initialDir)
  const toggle = (k: K, defaultDir: SortDir = 'desc') => {
    if (k === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setKey(k); setDir(defaultDir) }
  }
  return { key, dir, toggle }
}

export type Sort<K extends string> = ReturnType<typeof useSort<K>>

export function Th<K extends string>({ label, k, sort, align, defaultDir, title }: {
  label: string; k: K; sort: Sort<K>; align?: 'right'; defaultDir?: SortDir; title?: string
}) {
  const active = sort.key === k
  return (
    <th className={align === 'right' ? 'num' : undefined} title={title}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => sort.toggle(k, defaultDir)} className={active ? 'on' : undefined}>
        {label}{active && <span aria-hidden>{sort.dir === 'asc' ? ' ↑' : ' ↓'}</span>}
      </button>
    </th>
  )
}

/** Sort a copy of `list` by the active key. Text compares alphabetically; missing values
 *  (null/undefined) always go last whichever way the column is sorted. */
export function sortRows<T, K extends string>(
  list: T[], sort: Sort<K>, value: (row: T, key: K) => string | number | null | undefined,
): T[] {
  const key = sort.key
  if (key == null) return list
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const va = value(a, key), vb = value(b, key)
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1
    const c = typeof va === 'string' || typeof vb === 'string'
      ? String(va).localeCompare(String(vb))
      : va - vb
    return c * sign
  })
}
