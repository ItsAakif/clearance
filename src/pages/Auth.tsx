import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Lock, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { authApi } from "@/services/api/auth";
import { useQueryClient } from "@tanstack/react-query";
import { authKeys } from "@/hooks/useAuth";

export default function AuthPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      toast({ title: "Password required", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    try {
      const user = await authApi.login({ password });
      queryClient.setQueryData(authKeys.user, user);
      toast({ title: "Welcome to Clearance" });
      navigate("/app/resumes");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid password";
      toast({ title: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DotGridSection className="min-h-screen">
      <LandingHeader />
      <main className="mx-auto w-full max-w-sm px-4 pb-16 pt-24">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          <h1 className="page-title text-ink">Enter application password</h1>
          <p className="mt-1 text-sm text-ink-3">
            The password configured by the instance administrator.
          </p>
          <div className="mt-4 border-t border-rule" />

          <p className="mt-4 flex items-start gap-2 text-xs2 text-ink-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span>
              Default password: CHANGEME. Set APP_PASSWORD and restart before exposing this
              instance to a network.
            </span>
          </p>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="pl-10 pr-10"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "Logging in..." : "Enter"}
            </Button>
          </form>
        </motion.div>
      </main>
    </DotGridSection>
  );
}
