import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { Sidebar } from '@/components/Sidebar'
import { Topbar } from '@/components/Topbar'
import { TopbarProvider } from '@/lib/topbar-context'

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <TopbarProvider>
      <div className="flex h-screen bg-canvas overflow-hidden">
        <Sidebar user={user} />
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <Topbar />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </TopbarProvider>
  )
}
