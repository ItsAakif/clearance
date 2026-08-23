import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { motion } from "framer-motion";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompletePasswordReset } from "@/hooks/useAuth";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resetPasswordMutation = useCompletePasswordReset();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await resetPasswordMutation.mutateAsync({ token, password });
    navigate("/auth");
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
              <h1 className="text-2xl font-semibold text-foreground">Choose a new password</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Reset tokens are passed in the URL query string.
              </p>
            </div>

            {token ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="At least 8 characters"
                      className="pl-10 pr-10"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={resetPasswordMutation.isPending || password.length < 8}
                >
                  {resetPasswordMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    "Reset password"
                  )}
                </Button>
              </form>
            ) : (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                Missing reset token. Open this page from your password reset link.
              </div>
            )}
          </Card>
        </motion.div>
      </main>
    </DotGridSection>
  );
}
