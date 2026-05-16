'use client'

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

type Ctx = { actions: ReactNode; setActions: (a: ReactNode) => void }

const TopbarCtx = createContext<Ctx>({ actions: null, setActions: () => {} })

export function TopbarProvider({ children }: { children: ReactNode }) {
  const [actions, setActionsState] = useState<ReactNode>(null)
  const setActions = useCallback((a: ReactNode) => setActionsState(a), [])
  return <TopbarCtx.Provider value={{ actions, setActions }}>{children}</TopbarCtx.Provider>
}

export const useTopbarActions = () => useContext(TopbarCtx)
