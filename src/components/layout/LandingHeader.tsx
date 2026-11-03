import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";
import { landingNavItems } from "@/components/layout/navigation";

export function LandingHeader() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed left-0 right-0 top-0 z-50 transition-colors duration-150 ease-out",
        isScrolled ? "border-b border-rule bg-background" : "bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          to="/"
          className="font-display text-lg font-semibold tracking-tight text-foreground transition-colors duration-150 ease-out hover:text-primary"
        >
          Clearance
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {landingNavItems.map((item) => (
            item.kind === "anchor" ? (
              <a
                key={item.href}
                href={item.href}
                className="group relative text-sm text-ink-2 transition-colors duration-150 ease-out hover:text-foreground"
              >
                {item.label}
                <span className="absolute -bottom-1 left-0 h-px w-0 bg-primary transition-[width] duration-150 ease-out group-hover:w-full" />
              </a>
            ) : (
              <Link
                key={item.href}
                to={item.href}
                className="group relative text-sm text-ink-2 transition-colors duration-150 ease-out hover:text-foreground"
              >
                {item.label}
                <span className="absolute -bottom-1 left-0 h-px w-0 bg-primary transition-[width] duration-150 ease-out group-hover:w-full" />
              </Link>
            )
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link to="/app">Dashboard</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/get-started">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
