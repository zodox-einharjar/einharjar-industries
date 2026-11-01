import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Archivo, Big_Shoulders_Display } from 'next/font/google'
import { getCurrentUser } from '@/lib/auth'
import { TopNav } from './v2/_shared/TopNav'
import { RouteBaseProvider } from '@/lib/route-base'
import { TopbarProvider } from '@/lib/topbar-context'
import './trial.css'

// Trial frontend: its own fonts, tokens and chrome, isolated from the (shell) app
// so the classic pages are untouched while the new look is evaluated.

const display = Big_Shoulders_Display({
  subsets: ['latin'], weight: ['500', '700', '800'], variable: '--font-display',
})
const body = Archivo({
  subsets: ['latin'], axes: ['wdth'], variable: '--font-body',
})

export default async function TrialLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className={`v2 ${display.variable} ${body.variable}`}>
      <header className="v2-bar">
        <Link href="/v2" className="v2-wordmark">Einharjar Industries</Link>
        <TopNav />
        <Link href="/character" className="v2-pilot" title="Character">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={user.portrait_url} alt="" width={28} height={28} />
          <span>{user.character_name}</span>
        </Link>
      </header>
      <main className="v2-main">
        {/* Classic page components reused here put toolbar buttons in the topbar slot
            and link between pages relative to the route base. */}
        <RouteBaseProvider base="/v2">
          <TopbarProvider>{children}</TopbarProvider>
        </RouteBaseProvider>
      </main>
    </div>
  )
}
