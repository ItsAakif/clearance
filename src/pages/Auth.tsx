import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Lock, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
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
      <main className="container mx-auto max-w-sm px-4 pb-16 pt-24">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="p-6">
            <h1 className="text-xl font-semibold text-center mb-2">Enter Application Password</h1>
            <p className="text-sm text-muted-foreground text-center mb-6">
              Enter the password configured by the instance administrator.
            </p>

            <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Your instance is using the default password. Change it before exposing the application to a network.</span>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Logging in..." : "Enter"}
              </Button>
            </form>
          </Card>
        </motion.div>
      </main>
    </DotGridSection>
  );
}