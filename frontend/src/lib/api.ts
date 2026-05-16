import { cookies } from 'next/headers'

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8000'

/**
 * Server-side fetch to the FastAPI backend, forwarding the browser session cookie.
 * Call this only from Server Components or Server Actions.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookieStore = cookies()
  const cookieHeader = cookieStore
    .getAll()
    .map(c => `${c.name}=${c.value}`)
    .join('; ')

  return fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      ...(init.headers as Record<string, string>),
    },
    cache: 'no-store',
  })
}
