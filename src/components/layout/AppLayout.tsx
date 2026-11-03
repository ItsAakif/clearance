import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, LogOut, Menu } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { motion, AnimatePresence } from "framer-motion";
import { useLogout } from "@/hooks/useAuth";
import { appNavItemsFor, activeNavItemFor } from "@/components/layout/navigation";

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const logoutMutation = useLogout();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // The Studio needs the width for the A4 page, so on `/app/studio*` the sidebar is forced to
  // its icon rail and cannot be expanded. `userCollapsed` is kept rather than overwritten, so
  // leaving the Studio restores exactly the state the user had before entering it.
  //
  // ONE value drives everything: the rail width, the brand row, the labels and the chevron.
  // Deriving those from different inputs is what let the width and the header disagree.
  const forcedCollapsed = location.pathname.startsWith("/app/studio");
  const renderedCollapsed = forcedCollapsed || userCollapsed;

  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    navigate("/");
  };

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!sidebarOpen && menuButtonRef.current) menuButtonRef.current.focus();
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSidebar(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, closeSidebar]);

  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const dur = reducedMotion ? 0.05 : 0.15;

  const navItems = appNavItemsFor();
  const activeItem = activeNavItemFor(navItems, location.pathname);

  return (
    <div className="flex h-screen w-full bg-paper overflow-hidden">
      <a href="#app-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-control focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground print:hidden">
        Skip to main content
      </a>

      <AnimatePresence>
        {sidebarOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-ink/20 lg:hidden" />
        )}
      </AnimatePresence>

      {/* The width lives in a class, never in an inline style, so leaving the Studio cannot leave
          the rail stuck at the collapsed width. */}
      <aside
        style={{ transitionDuration: `${dur}s` }}
        className={cn(
          "fixed left-0 top-0 z-50 flex h-full flex-col border-r border-rule bg-paper",
          "transition-[width,transform] ease-out lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          renderedCollapsed ? "w-16" : "w-60",
          "print:hidden"
        )}
      >
        {/* Brand row: 28px mark + 20px wordmark on a 56px hairline row. Collapsed, the mark and
            the 24px chevron sit side by side in a centred row with a gap, so neither is clipped
            or overlapped by the 64px rail. */}
        <div
          className={cn(
            "relative flex h-14 shrink-0 items-center border-b border-rule px-3",
            renderedCollapsed ? "justify-center gap-1 px-1" : "justify-between",
          )}
        >
          <div className={cn("flex min-w-0 items-center", renderedCollapsed ? "justify-center" : "gap-2.5")}>
            <img src="/android-chrome-192x192.png" alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
            {!renderedCollapsed && <span className="truncate font-sans text-xl font-semibold leading-none tracking-tight text-ink">Clearance</span>}
          </div>
          {!forcedCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={renderedCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="h-6 w-6 shrink-0 text-ink-3"
              onClick={() => setUserCollapsed((v) => !v)}
            >
              {renderedCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          )}
        </div>

        {/* Nav: 14px labels, 36px rows, 18px icons, active = a pill. */}
        <nav className="flex-1 overflow-y-auto px-2 py-4">
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = activeItem?.href === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={closeSidebar}
                  title={renderedCollapsed ? item.label : undefined}
                  className={cn(
                    "relative flex h-9 items-center gap-3 rounded-full text-[14px] transition-colors duration-150 ease-out",
                    renderedCollapsed ? "justify-center px-0" : "px-3",
                    active
                      ? "bg-sidebar-accent text-ink"
                      : "text-ink-2 hover:bg-paper-2 hover:text-ink"
                  )}
                >
                  {Icon && <Icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-ink" : "text-ink-3")} />}
                  {!renderedCollapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Bottom */}
        <div className="shrink-0 space-y-1 border-t border-rule px-2 py-3">
          <button
            onClick={handleLogout}
            className={cn(
              "flex h-9 w-full items-center gap-3 text-[14px] text-ink-2 transition-colors duration-150 ease-out hover:bg-paper-2 hover:text-ink",
              renderedCollapsed ? "justify-center px-0" : "px-3"
            )}
          >
            <LogOut className="h-[18px] w-[18px] shrink-0 text-ink-3" />
            {!renderedCollapsed && <span>Logout</span>}
          </button>
          {!renderedCollapsed ? (
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-sm text-ink-3">Dark Mode</span>
              <ThemeToggle />
            </div>
          ) : (
            <div className="flex justify-center py-1"><ThemeToggle /></div>
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule bg-paper px-3 lg:hidden print:hidden">
          <Button ref={menuButtonRef} variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <span className="page-title text-[17px] leading-none">Clearance</span>
        </header>
        <main id="app-main" tabIndex={-1} className="flex-1 overflow-auto focus:outline-none print:overflow-visible print:h-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
