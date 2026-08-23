import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Loader2, MailWarning } from "lucide-react";
import { motion } from "framer-motion";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { authApi } from "@/services/api/auth";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authKeys } from "@/hooks/useAuth";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const verifyMutation = useMutation({
    mutationFn: async () => authApi.verifyEmail(token),
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.user, user);
      toast({
        title: "Email verified",
        description: "Your Clearance account is now verified.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Verification failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (token && verifyMutation.status === "idle") {
      verifyMutation.mutate();
    }
  }, [token, verifyMutation]);

  const isSuccess = verifyMutation.isSuccess;
  const isError = verifyMutation.isError || !token;

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

          <Card className="p-6 text-center">
            {verifyMutation.isPending ? (
              <>
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <h1 className="mt-4 text-2xl font-semibold text-foreground">Verifying your email</h1>
                <p className="mt-2 text-sm text-muted-foreground">We’re confirming your verification link now.</p>
              </>
            ) : isSuccess ? (
              <>
                <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
                <h1 className="mt-4 text-2xl font-semibold text-foreground">Email verified</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your account is ready. You can continue into the app.
                </p>
                <Button asChild className="mt-6 w-full">
                  <Link to="/app/resumes">Open app</Link>
                </Button>
              </>
            ) : (
              <>
                <MailWarning className="mx-auto h-8 w-8 text-destructive" />
                <h1 className="mt-4 text-2xl font-semibold text-foreground">Verification unavailable</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {isError
                    ? "That verification link is missing, invalid, or expired."
                    : "We could not verify this email address."}
                </p>
                <Button asChild variant="outline" className="mt-6 w-full">
                  <Link to="/app/settings">Open settings</Link>
                </Button>
              </>
            )}
          </Card>
        </motion.div>
      </main>
    </DotGridSection>
  );
}
