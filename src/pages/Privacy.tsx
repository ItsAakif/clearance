import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";

export default function PrivacyPage() {
  return (
    <DotGridSection className="min-h-screen">
      <LandingHeader />
      <main className="container mx-auto max-w-3xl px-4 pb-16 pt-24">
        <h1 className="text-3xl font-semibold text-foreground">Privacy Policy</h1>
        <div className="mt-6 space-y-4 text-sm leading-6 text-muted-foreground">
          <p>Clearance stores account details, resumes, ATS reports, and subscription metadata needed to deliver the service.</p>
          <p>Public ATS scans are processed temporarily and stored only as anonymous reports without account linkage.</p>
          <p>You can delete your account from settings to remove your user profile and related resume data.</p>
        </div>
      </main>
    </DotGridSection>
  );
}
