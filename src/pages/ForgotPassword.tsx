import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { motion } from "framer-motion";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForgotPassword } from "@/hooks/useAuth";

export default function ForgotPasswordPage() {
  const forgotPasswordMutation = useForgotPassword();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await forgotPasswordMutation.mutateAsync(email);
    setSubmitted(true);
  };

  return (
    <DotGridSection className="min-h-screen">
      <LandingHeader />

      <main className="container mx-auto max-w-md px-4 pb-16 pt-24">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <Link
            to="/auth"
            className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to login
          </Link>

          <Card className="p-6">
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-semibold text-foreground">Reset your password</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter your email and we&apos;ll start the password reset flow.
              </p>
            </div>

            {submitted ? (
              <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm text-muted-foreground">
                If an account exists for <span className="font-medium text-foreground">{email}</span>, a reset
                link has been sent.
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      className="pl-10"
                      required
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={forgotPasswordMutation.isPending || !email}>
                  {forgotPasswordMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Send reset link"
                  )}
                </Button>
              </form>
            )}
          </Card>
        </motion.div>
      </main>
    </DotGridSection>
  );
}
