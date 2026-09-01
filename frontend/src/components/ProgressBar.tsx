export function ProgressBar({
  label, pct, sublabel, barColor = 'bg-accent',
}: {
  label: string
  pct: number
  sublabel?: string
  barColor?: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between text-[10px] text-muted mb-0.5">
        <span>{label}</span>
        <span>{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-wire overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${clamped}%` }} />
      </div>
      {sublabel && <div className="text-[10px] text-faint mt-0.5">{sublabel}</div>}
    </div>
  )
}
