import { useEffect, useState } from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Returns true when viewport width < breakpoint (default 768).
 * Safe for SSR: defaults to false until mounted.
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return

    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)

    const onChange = () => setIsMobile(mql.matches)
    onChange()

    // Safari <14 uses addListener
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    }
    const legacyMql = mql as unknown as { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void }
    legacyMql.addListener(onChange)
    return () => legacyMql.removeListener(onChange)
  }, [breakpoint])

  return isMobile
}

export { MOBILE_BREAKPOINT }
