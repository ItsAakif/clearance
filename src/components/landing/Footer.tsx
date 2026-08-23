import { Link } from "react-router-dom";

const productLinks = [
  { label: "Resume Builder", href: "/app/build" },
  { label: "ATS Scan", href: "/ats-scan" },
  { label: "Job Match", href: "/app/match" },
];

const companyLinks = [
  { label: "About", href: "#" },
  { label: "Privacy", href: "#" },
  { label: "Terms", href: "#" },
];

export const Footer = () => {
  return (
    <footer className="border-t border-border bg-secondary/20">
      <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
        <div className="grid gap-8 md:grid-cols-4">
          {/* Brand */}
          <div className="md:col-span-2">
            <Link to="/" className="text-xl font-semibold text-foreground">
              Clearance
            </Link>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Built for job seekers. Not recruiters. Not ads.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-sm font-semibold text-foreground">Product</h4>
            <ul className="mt-4 space-y-3">
              {productLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    to={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-sm font-semibold text-foreground">Company</h4>
            <ul className="mt-4 space-y-3">
              {companyLinks.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 md:flex-row">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Clearance. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
};
