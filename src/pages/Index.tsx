import InteractiveDotGrid from "@/components/backgrounds/InteractiveDotGrid";
import {
  LandingNav,
  Hero,
  FactsRow,
  Features,
  HowItWorks,
  SelfHost,
  ClosingCTA,
  LandingFooter,
} from "@/components/landing";

// The public landing page. It is intentionally self-contained: no app shell, no
// auth hook, no API client and no router. "Open the app" destinations go through
// `appHref` so this tree can be deployed beside, or away from, the app itself.
const Index = () => {
  return (
    <div id="top" className="relative min-h-screen text-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black_0%,black_80%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_80%,transparent_100%)]"
      >
        <InteractiveDotGrid />
      </div>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <LandingNav />
      <main id="main">
        <Hero />
        <FactsRow />
        <Features />
        <HowItWorks />
        <SelfHost />
        <ClosingCTA />
      </main>
      <LandingFooter />
    </div>
  );
};

export default Index;
