'use client'

import { createContext, useContext, type ReactNode } from 'react'

// Path prefix for links between pages that exist in both the classic app and the
// trial redesign: "" in the classic app, "/v2" in the trial, so each keeps you inside it.
const RouteBaseCtx = createContext('')

export function RouteBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <RouteBaseCtx.Provider value={base}>{children}</RouteBaseCtx.Provider>
}

export const useRouteBase = () => useContext(RouteBaseCtx)
