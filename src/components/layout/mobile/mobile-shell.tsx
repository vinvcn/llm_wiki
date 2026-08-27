import { useState, useCallback } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { BottomTabBar } from "./bottom-tab-bar"
import { MobileSheet } from "./mobile-sheet"
import { ContentArea } from "../content-area"
import { SidebarPanel } from "../sidebar-panel"
import { PreviewPanel } from "../preview-panel"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { SettingsView } from "@/components/settings/settings-view"
import { SkillsSection } from "@/components/settings/sections/skills-section"
import { ResearchPanel } from "../research-panel"
import { ErrorBoundary } from "@/components/error-boundary"
import { UpdateBanner } from "../update-banner"
import { useTranslation } from "react-i18next"
import {
  FolderOpen,
  ClipboardList,
  ClipboardCheck,
  Sparkles,
  Settings,
  Globe,
  ArrowLeftRight,
} from "lucide-react"
import type { WikiState } from "@/stores/wiki-store"

type NavView = WikiState["activeView"]

interface MoreItem {
  view: NavView | "research"
  labelKey: string
  icon: typeof FolderOpen
}

const MORE_ITEMS: MoreItem[] = [
  { view: "sources", labelKey: "nav.sources", icon: FolderOpen },
  { view: "review", labelKey: "nav.review", icon: ClipboardList },
  { view: "lint", labelKey: "nav.lint", icon: ClipboardCheck },
  { view: "skills", labelKey: "nav.skills", icon: Sparkles },
  { view: "settings", labelKey: "nav.settings", icon: Settings },
  { view: "research", labelKey: "research.title", icon: Globe },
]

interface MobileShellProps {
  onSwitchProject: () => void
}

export function MobileShell({ onSwitchProject }: MobileShellProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const setResearchPanelOpen = useResearchStore((s) => s.setPanelOpen)

  const [moreOpen, setMoreOpen] = useState(false)
  const [researchSheetOpen, setResearchSheetOpen] = useState(false)

  const handleMoreItem = useCallback(
    (item: MoreItem) => {
      setMoreOpen(false)
      if (item.view === "research") {
        setResearchSheetOpen(true)
        setResearchPanelOpen(true)
        return
      }
      setActiveView(item.view as NavView)
    },
    [setActiveView, setResearchPanelOpen],
  )

  // Determine sheet title for current more view
  const sheetForActive = (() => {
    if (researchSheetOpen) return { title: t("research.title"), view: "research" as const }
    const match = MORE_ITEMS.find((i) => i.view === activeView)
    if (match && ["sources", "review", "lint", "skills", "settings"].includes(match.view)) {
      return { title: t(match.labelKey), view: match.view }
    }
    return null
  })()

  const showSheet =
    (sheetForActive !== null && ["sources", "review", "lint", "skills", "settings"].includes(sheetForActive.view)) ||
    researchSheetOpen

  const sheetTitle = sheetForActive?.title ?? ""

  const renderSheetContent = () => {
    if (researchSheetOpen) {
      return <ResearchPanel />
    }
    switch (activeView) {
      case "sources":
        return <SourcesView />
      case "review":
        return <ReviewView />
      case "lint":
        return <LintView />
      case "skills":
        return (
          <div className="px-4 py-4">
            <SkillsSection />
          </div>
        )
      case "settings":
        return <SettingsView />
      default:
        return null
    }
  }

  // When a sheet is open for a more-view, we still want ContentArea for wiki/search/chat/graph behind,
  // but the sheet overlays. Closing the sheet should return to wiki if we were on a more view?
  // Keep behavior simple: close sheet leaves activeView as is (so reopening shows same view behind sheet closure).
  const closeSheet = useCallback(() => {
    if (researchSheetOpen) {
      setResearchSheetOpen(false)
      return
    }
    // For settings/sources etc, navigate back to wiki
    if (MORE_ITEMS.some((i) => i.view === activeView)) {
      setActiveView("wiki")
    }
  }, [activeView, researchSheetOpen, setActiveView])

  const isSheetOpen = Boolean(showSheet)

  // Also watch research store: if panel closed externally, close sheet
  // (not strictly needed, but keeps sync)
  if (researchSheetOpen && !researchPanelOpen) {
    // Close sheet if research was toggled off elsewhere
    // Do it via effect timing — schedule close
    setTimeout(() => setResearchSheetOpen(false), 0)
  }

  // Mobile wiki: list when no file, preview when file selected
  const isWikiView = activeView === "wiki"
  const showWikiList = isWikiView && !selectedFile
  const showWikiPreview = isWikiView && Boolean(selectedFile)

  const renderCenter = () => {
    if (showWikiList) {
      return (
        <div className="flex h-full flex-col overflow-hidden" data-testid="mobile-wiki-list">
          <SidebarPanel />
        </div>
      )
    }
    if (showWikiPreview) {
      return (
        <div className="flex h-full flex-col overflow-hidden" data-testid="mobile-wiki-preview">
          <ErrorBoundary>
            <PreviewPanel />
          </ErrorBoundary>
        </div>
      )
    }
    // chat / search / graph use the shared ContentArea
    return (
      <ErrorBoundary>
        <ContentArea />
      </ErrorBoundary>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Center content: full-width, no side panels */}
        <div className="min-w-0 flex-1 overflow-hidden">{renderCenter()}</div>
        <BottomTabBar onMore={() => setMoreOpen(true)} />
      </div>

      {/* More menu sheet — grid of secondary destinations */}
      <MobileSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={t("nav.more", "More")}>
        <div className="grid grid-cols-3 gap-3 p-4">
          {MORE_ITEMS.map(({ view, labelKey, icon: Icon }) => (
            <button
              key={view}
              type="button"
              onClick={() => handleMoreItem({ view, labelKey, icon: Icon })}
              className="flex flex-col items-center gap-2 rounded-xl border bg-card p-4 text-card-foreground transition-colors hover:bg-accent"
              data-testid={`more-${view}`}
            >
              <Icon className="h-6 w-6 text-muted-foreground" />
              <span className="text-xs font-medium">{t(labelKey)}</span>
            </button>
          ))}
        </div>
        <div className="border-t p-3">
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false)
              onSwitchProject()
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="more-switch-project"
          >
            <ArrowLeftRight className="h-4 w-4" />
            {t("nav.switchProject")}
          </button>
        </div>
      </MobileSheet>

      {/* Full-screen sheet for secondary panels */}
      <MobileSheet open={isSheetOpen} onClose={closeSheet} title={sheetTitle}>
        <ErrorBoundary>{renderSheetContent()}</ErrorBoundary>
      </MobileSheet>
    </div>
  )
}
