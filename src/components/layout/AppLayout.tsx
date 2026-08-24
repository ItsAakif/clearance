import { Link, useLocation, useNavigate } from "react-router-dom";
import { type LucideIcon, FileText, FolderOpen, Settings, Menu, ChevronLeft, ChevronRight, Search, LogOut, ScanSearch, ShieldCheck, Briefcase, KanbanSquare, UserCog, History, MessageSquare, X } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { motion, AnimatePresence } from "framer-motion";
import { useLogout } from "@/hooks/useAuth";
import { useAuth } from "@/hooks/useAuth";
import { NavLink } from "@/components/NavLink";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  prominent?: boolean;
};

type NavGroup = {
  label: "WORK" | "JOBS" | "OPTIMISE" | "PROFILE" | "SYSTEM" | "ADMIN";
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  { label: "WORK", items: [
    { label: "My Resumes", href: "/app/resumes", icon: FolderOpen },
    { label: "Build", href: "/app/build", icon: FileText },
  ] },
  { label: "JOBS", items: [
    { label: "Job Search", href: "/app/jobs", icon: Briefcase, prominent: true },
    { label: "Applications", href: "/app/applications", icon: KanbanSquare },
    { label: "Q&A Bank", href: "/app/qa-bank", icon: MessageSquare },
  ] },
  { label: "OPTIMISE", items: [
    { label: "ATS Scan", href: "/app/ats-scan", icon: ScanSearch },
    { label: "ATS History", href: "/app/ats-history", icon: History },
  ] },
  { label: "PROFILE", items: [
    { label: "Career Profile", href: "/app/profile", icon: UserCog },
  ] },
  { label: "SYSTEM", items: [
    { label: "Settings", href: "/app/settings", icon: Settings },
  ] },
];

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const logoutMutation = useLogout();
  const { user } = useAuth();

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstNavLinkRef = useRef<HTMLAnchorElement>(null);

  const visibleGroups = user?.isAdmin
    ? [...navGroups, { label: "ADMIN" as const, items: [{ label: "Admin", href: "/app/admin", icon: ShieldCheck }] }]
    : navGroups;

  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    navigate("/");
  };

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  // Focus first nav link when mobile sidebar opens
  useEffect(() => {
    if (sidebarOpen && firstNavLinkRef.current) {
      firstNavLinkRef.current.focus();
    }
  }, [sidebarOpen]);

  // Restore focus to menu button when mobile sidebar closes
  useEffect(() => {
    if (!sidebarOpen && menuButtonRef.current) {
      menuButtonRef.current.focus();
    }
  }, [sidebarOpen]);

  // Escape closes mobile sidebar
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, closeSidebar]);

  // Respect prefers-reduced-motion
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const animDuration = reducedMotion ? 0.05 : 0.2;

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Skip link */}
      <a
        href="#app-main"
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground focus:ring-2 focus:ring-ring"
        )}
      >
        Skip to main content
      </a>

      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: animDuration }}
            className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm lg:hidden"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        id="app-sidebar"
        initial={false}
        animate={{ width: collapsed ? 72 : 256 }}
        transition={{ duration: animDuration, ease: "easeOut" }}
        className={cn(
          "fixed left-0 top-0 z-50 flex h-full flex-col border-r border-sidebar-border bg-sidebar",
          "transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        aria-label="Application navigation"
      >
        {/* Logo & Collapse */}
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-3">
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: animDuration }}
                  className="overflow-hidden"
                >
                  <span className="text-lg font-semibold text-sidebar-foreground whitespace-nowrap">
                    Clearance
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className={cn("hidden lg:flex h-8 w-8 text-muted-foreground hover:text-foreground")}
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden h-8 w-8"
            onClick={closeSidebar}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className={cn("relative transition-all", collapsed ? "w-10" : "w-full")}>
            {collapsed ? (
              <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground" aria-label="Search">
                <Search className="h-4 w-4" />
              </Button>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  placeholder="Search..."
                  aria-label="Search navigation"
                  className="pl-9 bg-secondary/50 border-sidebar-border focus-visible:ring-sidebar-ring"
                />
              </div>
            )}
          </div>
        </div>

        {/* Navigation groups */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Application navigation">
          {visibleGroups.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-labelledby={`nav-group-${group.label}`}
              className="space-y-1"
            >
              {!collapsed && (
                <p
                  id={`nav-group-${group.label}`}
                  className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70"
                >
                  {group.label}
                </p>
              )}
              {group.items.map((item, index) => {
                const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + "/");
                const isFirst = index === 0 && group.label === visibleGroups[0]?.label;
                return (
                  <NavLink
                    key={item.href}
                    to={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={({ isActive: navActive }) =>
                      cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                        collapsed ? "justify-center" : "",
                        navActive
                          ? "bg-primary text-primary-foreground shadow-md"
                          : "text-muted-foreground hover:bg-secondary hover:text-sidebar-foreground",
                        item.prominent && !navActive && "font-medium"
                      )
                    }
                    onClick={() => setSidebarOpen(false)}
                    ref={isFirst && !collapsed ? firstNavLinkRef : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className={cn("h-5 w-5 shrink-0 transition-transform duration-200", !isActive && "group-hover:scale-110")} />
                    {!collapsed && (
                      <span className="whitespace-nowrap overflow-hidden">
                        {item.label}
                      </span>
                    )}
                    {collapsed && (
                      <span className="sr-only">{item.label}</span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Bottom section */}
        <div className="border-t border-sidebar-border p-3 space-y-2">
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-sidebar-foreground disabled:opacity-60",
              collapsed ? "justify-center" : ""
            )}
            aria-label="Log out"
            title={collapsed ? "Logout" : undefined}
          >
            <LogOut className="h-5 w-5 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">Logout</span>}
            {collapsed && <span className="sr-only">Logout</span>}
          </button>

          <div className={cn("flex items-center rounded-lg px-3 py-2", collapsed ? "justify-center" : "justify-between")}>
            {!collapsed && <span className="text-sm text-muted-foreground">Dark Mode</span>}
            <ThemeToggle />
          </div>
        </div>
      </motion.aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Mobile header */}
        <header className="flex h-16 items-center gap-4 border-b border-border bg-card px-4 lg:hidden">
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-xs">
              CL
            </div>
            <span className="text-lg font-semibold">Clearance</span>
          </div>
        </header>

        {/* Page content */}
        <main
          id="app-main"
          tabIndex={-1}
          aria-label="Main content"
          className="flex-1 overflow-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
