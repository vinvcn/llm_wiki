import { FileText, Search, MessageSquare, Network, MoreHorizontal } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiState } from "@/stores/wiki-store"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

type NavView = WikiState["activeView"]

interface TabItem {
  view: NavView | "more"
  icon: typeof FileText
  labelKey: string
  testId: string
}

const TABS: TabItem[] = [
  { view: "wiki", icon: FileText, labelKey: "nav.wiki", testId: "tab-wiki" },
  { view: "search", icon: Search, labelKey: "nav.search", testId: "tab-search" },
  { view: "chat", icon: MessageSquare, labelKey: "nav.chat", testId: "tab-chat" },
  { view: "graph", icon: Network, labelKey: "nav.graph", testId: "tab-graph" },
  { view: "more", icon: MoreHorizontal, labelKey: "nav.more", testId: "tab-more" },
]

const MORE_VIEWS: Set<NavView> = new Set(["sources", "review", "lint", "skills", "settings"])

interface BottomTabBarProps {
  onMore: () => void
}

export function BottomTabBar({ onMore }: BottomTabBarProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const isMoreActive = MORE_VIEWS.has(activeView)

  return (
    <nav
      aria-label="Primary"
      data-testid="bottom-tab-bar"
      className="sticky bottom-0 z-50 flex h-[56px] shrink-0 items-center justify-around border-t bg-background px-1 pb-[env(safe-area-inset-bottom)] touch-manipulation"
    >
      {TABS.map(({ view, icon: Icon, labelKey, testId }) => {
        const isActive = view === "more" ? isMoreActive : activeView === view
        const label = t(labelKey, view === "more" ? "More" : view)

        const onClick = () => {
          // On iOS, the first tap while an input is focused dismisses the keyboard
          // instead of firing the button's click. Blur the focused input first so
          // the navigation always lands on the first tap (graph search, chat, etc.).
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
          }
          if (view === "more") {
            onMore()
          } else {
            setActiveView(view as NavView)
          }
        }

        return (
          <button
            key={view}
            type="button"
            data-testid={testId}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            onClick={onClick}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-md py-1 text-[10px] leading-none transition-colors",
              isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={cn("h-5 w-5", isActive && "fill-primary/15")} />
            <span className={cn("font-medium", isActive ? "text-primary" : "text-muted-foreground")}>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
