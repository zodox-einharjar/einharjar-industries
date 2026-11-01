import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Archivo, Big_Shoulders_Display } from 'next/font/google'
import { getCurrentUser } from '@/lib/auth'
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
        <nav className="v2-bar-links">
          <Link href="/v2/doctrines">Doctrines</Link>
          <Link href="/shopping">Shopping</Link>
          <Link href="/industry">Industry</Link>
          <Link href="/market-orders">Market</Link>
          <Link href="/" className="v2-classic">Classic view</Link>
        </nav>
        <div className="v2-pilot">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={user.portrait_url} alt="" width={28} height={28} />
          <span>{user.character_name}</span>
        </div>
      </header>
      <main className="v2-main">{children}</main>
    </div>
  )
}
