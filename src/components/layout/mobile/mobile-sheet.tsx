import { useEffect } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface MobileSheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  className?: string
}

/**
 * Full-screen sheet sliding over mobile content.
 * Fixed inset-0, slides up via translate, traps scroll inside.
 * No dependency on Dialog — avoids portal / focus-lock issues on mobile.
 */
export function MobileSheet({ open, onClose, title, children, className }: MobileSheetProps) {
  // Prevent body scroll when sheet open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      aria-modal="true"
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-3">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className={cn("flex-1 overflow-auto", className)}>{children}</div>
    </div>
  )
}
