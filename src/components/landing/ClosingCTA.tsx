import { appHref } from "@/lib/landingLinks";

export function ClosingCTA() {
  return (
    <section
      aria-labelledby="closing-title"
      className="mx-auto w-full max-w-[1320px] px-6 py-24 text-center sm:px-8 md:py-28"
    >
      <h2
        id="closing-title"
        className="mx-auto max-w-3xl font-display text-[36px] font-medium leading-[1.1] tracking-[-0.02em] text-ink md:text-[48px]"
      >
        Start with the resume you already have.
      </h2>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-5">
        <a
          href={appHref("/get-started")}
          className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-7 text-[15px] font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Start building
        </a>
        <a
          href="#self-hosting"
          className="inline-flex min-h-[44px] items-center rounded-control text-[15px] font-medium text-ink-3 underline decoration-rule-strong underline-offset-4 transition-colors duration-150 ease-out hover:text-ink hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          or run it locally
        </a>
      </div>
    </section>
  );
}
