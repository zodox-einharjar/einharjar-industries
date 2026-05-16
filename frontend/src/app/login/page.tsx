import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Login' }

function HexLogo() {
  return (
    <svg width="52" height="60" viewBox="0 0 26 30" fill="none">
      <path
        d="M13 1.5L24.5 8V22L13 28.5L1.5 22V8L13 1.5Z"
        fill="var(--accent)"
        fillOpacity="0.12"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
      <path
        d="M13 8.5L19.5 12.25V19.75L13 23.5L6.5 19.75V12.25L13 8.5Z"
        fill="var(--accent)"
      />
    </svg>
  )
}

export default async function LoginPage() {
  const user = await getCurrentUser()
  if (user) redirect('/')

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center">
      <div className="flex flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-4">
          <HexLogo />
          <div className="text-center">
            <div className="text-primary font-semibold text-lg">Einharjar Industries</div>
          </div>
        </div>

        <a
          href="/auth/login"
          className="flex items-center gap-3 px-6 py-3 bg-surface border border-wire rounded text-primary text-sm hover:bg-surface-hi transition-colors"
        >
          <span className="font-bold tracking-widest text-accent text-base">EVE</span>
          <span>Login with EVE Online</span>
        </a>
      </div>
    </div>
  )
}
