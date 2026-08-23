import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";

export default function TermsPage() {
  return (
    <DotGridSection className="min-h-screen">
      <LandingHeader />
      <main className="container mx-auto max-w-3xl px-4 pb-16 pt-24">
        <h1 className="text-3xl font-semibold text-foreground">Terms of Service</h1>
        <div className="mt-6 space-y-4 text-sm leading-6 text-muted-foreground">
          <p>Clearance helps users create and optimize resumes for professional job applications.</p>
          <p>Users are responsible for the accuracy of uploaded content, exported resumes, and submitted job materials.</p>
          <p>Abuse of scanning, AI, or payment systems may result in account suspension.</p>
        </div>
      </main>
    </DotGridSection>
  );
}
