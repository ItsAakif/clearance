import { Link, useLocation, useNavigate } from "react-router-dom";
import { FileText, FolderOpen, Settings, ChevronLeft, ChevronRight, Search, LogOut, ScanSearch, Briefcase, KanbanSquare, UserCog, History, MessageSquare, X, Menu } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { motion, AnimatePresence } from "framer-motion";
import { useLogout } from "@/hooks/useAuth";

const navItems = [
  { label: "My Resumes", href: "/app/resumes", icon: FolderOpen },
  { label: "Build", href: "/app/build", icon: FileText },
  { label: "Job Search", href: "/app/jobs", icon: Briefcase },
  { label: "Applications", href: "/app/applications", icon: KanbanSquare },
  { label: "Q&A Bank", href: "/app/qa-bank", icon: MessageSquare },
  { label: "ATS Scan", href: "/app/ats-scan", icon: ScanSearch },
  { label: "ATS History", href: "/app/ats-history", icon: History },
  { label: "Career Profile", href: "/app/profile", icon: UserCog },
  { label: "Settings", href: "/app/settings", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const logoutMutation = useLogout();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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
  const dur = reducedMotion ? 0.05 : 0.2;

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <a href="#app-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground">
        Skip to main content
      </a>

      <AnimatePresence>
        {sidebarOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm lg:hidden" />
        )}
      </AnimatePresence>

      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 64 : 240 }}
        transition={{ duration: dur, ease: "easeOut" }}
        className={cn(
          "fixed left-0 top-0 z-50 flex h-full flex-col border-r bg-sidebar",
          "transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
          {!collapsed && <span className="text-sm font-semibold text-sidebar-foreground">Clearance</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {navItems.map((item) => {
            const active = location.pathname === item.href || location.pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                to={item.href}
                onClick={closeSidebar}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md text-sm transition-colors",
                  collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2",
                  active
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:bg-secondary hover:text-sidebar-foreground"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div className="shrink-0 border-t px-2 py-2 space-y-1">
          <button
            onClick={handleLogout}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-sidebar-foreground",
              collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2"
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Logout</span>}
          </button>
          {!collapsed ? (
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-xs text-muted-foreground">Dark Mode</span>
              <ThemeToggle />
            </div>
          ) : (
            <div className="flex justify-center py-1"><ThemeToggle /></div>
          )}
        </div>
      </motion.aside>

      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-3 lg:hidden">
          <Button ref={menuButtonRef} variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <span className="text-sm font-semibold">Clearance</span>
        </header>
        <main id="app-main" tabIndex={-1} className="flex-1 overflow-auto focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}