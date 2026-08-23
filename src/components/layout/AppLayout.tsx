import { Link, useLocation, useNavigate } from "react-router-dom";
import { FileText, FolderOpen, Settings, Menu, ChevronLeft, ChevronRight, Search, LogOut, ScanSearch, ShieldCheck, Briefcase, KanbanSquare, UserCog, History } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { motion, AnimatePresence } from "framer-motion";
import { useLogout } from "@/hooks/useAuth";
import { useAuth } from "@/hooks/useAuth";

const baseNavItems = [
  {
    label: "My Resumes",
    href: "/app/resumes",
    icon: FolderOpen,
  },
  {
    label: "Build",
    href: "/app/build",
    icon: FileText,
  },
  {
    label: "ATS Scan",
    href: "/app/ats-scan",
    icon: ScanSearch,
  },
  {
    label: "ATS History",
    href: "/app/ats-history",
    icon: History,
  },
  {
    label: "Job Search",
    href: "/app/jobs",
    icon: Briefcase,
  },
  {
    label: "Applications",
    href: "/app/applications",
    icon: KanbanSquare,
  },
  {
    label: "Profile",
    href: "/app/profile",
    icon: UserCog,
  },
  {
    label: "Settings",
    href: "/app/settings",
    icon: Settings,
  },
];
interface AppLayoutProps {
  children: React.ReactNode;
}
export function AppLayout({
  children
}: AppLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const logoutMutation = useLogout();
  const { user } = useAuth();
  const navItems = user?.isAdmin
    ? [...baseNavItems, { label: "Admin", href: "/app/admin", icon: ShieldCheck }]
    : baseNavItems;

  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    navigate("/");
  };

  return <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {sidebarOpen && <motion.div initial={{
        opacity: 0
      }} animate={{
        opacity: 1
      }} exit={{
        opacity: 0
      }} className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside initial={false} animate={{
      width: collapsed ? 72 : 256
    }} transition={{
      duration: 0.2,
      ease: "easeOut"
    }} className={cn("fixed left-0 top-0 z-50 flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 lg:static lg:translate-x-0", sidebarOpen ? "translate-x-0" : "-translate-x-full")}>
        {/* Logo & Collapse */}
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-3">
            
            <AnimatePresence>
              {!collapsed && <motion.div initial={{
              opacity: 0,
              width: 0
            }} animate={{
              opacity: 1,
              width: "auto"
            }} exit={{
              opacity: 0,
              width: 0
            }} className="overflow-hidden">
                  <span className="text-lg font-semibold text-sidebar-foreground whitespace-nowrap">
                    Clearance
                  </span>
                  <p className="text-xs text-muted-foreground whitespace-nowrap">
              </p>
                </motion.div>}
            </AnimatePresence>
          </Link>
          <Button variant="ghost" size="icon" className="hidden lg:flex h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={() => setSidebarOpen(false)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className={cn("relative transition-all", collapsed ? "w-10" : "w-full")}>
            {collapsed ? <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground">
                <Search className="h-4 w-4" />
              </Button> : <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search..." className="pl-9 bg-secondary/50 border-sidebar-border focus-visible:ring-sidebar-ring" />
              </div>}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-2">
          {navItems.map((item, index) => {
          const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + "/");
          return <motion.div key={item.href} initial={{
            opacity: 0,
            x: -20
          }} animate={{
            opacity: 1,
            x: 0
          }} transition={{
            delay: index * 0.05
          }}>
                <Link to={item.href} className={cn("group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200", collapsed ? "justify-center" : "", isActive ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:bg-secondary hover:text-sidebar-foreground")} onClick={() => setSidebarOpen(false)}>
                  <item.icon className={cn("h-5 w-5 transition-transform duration-200", !isActive && "group-hover:scale-110")} />
                  <AnimatePresence>
                    {!collapsed && <motion.span initial={{
                  opacity: 0,
                  width: 0
                }} animate={{
                  opacity: 1,
                  width: "auto"
                }} exit={{
                  opacity: 0,
                  width: 0
                }} className="whitespace-nowrap overflow-hidden">
                        {item.label}
                      </motion.span>}
                  </AnimatePresence>
                </Link>
              </motion.div>;
        })}
        </nav>

        {/* Bottom section */}
        <div className="border-t border-sidebar-border p-3 space-y-2">
          {/* Logout */}
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-sidebar-foreground disabled:opacity-60", collapsed ? "justify-center" : "")}
          >
            <LogOut className="h-5 w-5" />
            {!collapsed && <span>Logout</span>}
          </button>

          {/* Theme Toggle */}
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
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
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
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>;
}
