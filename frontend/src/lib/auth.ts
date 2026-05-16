import { cookies } from 'next/headers'

export interface CurrentUser {
  character_id: number
  character_name: string
  corp_name: string | null
  portrait_url: string
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = cookies()
  const cookieHeader = cookieStore
    .getAll()
    .map(c => `${c.name}=${c.value}`)
    .join('; ')

  if (!cookieHeader) return null

  const backend = process.env.BACKEND_URL ?? 'http://localhost:8000'

  try {
    const res = await fetch(`${backend}/auth/me`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}
