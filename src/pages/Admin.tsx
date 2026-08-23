import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, Images, Loader2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/services/api/admin';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';

export default function AdminPage() {
  const { user, isLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const templatesQuery = useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: () => adminApi.getTemplates(),
    enabled: Boolean(user?.isAdmin),
  });

  const refreshTemplatesMutation = useMutation({
    mutationFn: () => adminApi.refreshTemplates(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      toast({ title: 'Templates refreshed' });
    },
    onError: (error: Error) => {
      toast({ title: 'Template refresh failed', description: error.message, variant: 'destructive' });
    },
  });

  const generatePreviewsMutation = useMutation({
    mutationFn: () => adminApi.generateTemplatePreviews(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      toast({ title: 'Template previews generated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Preview generation failed', description: error.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (!user?.isAdmin) {
    return <Navigate to="/app/resumes" replace />;
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col overflow-auto">
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">Admin</h1>
              <p className="text-sm text-muted-foreground">Templates and maintenance tooling</p>
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Images className="h-5 w-5 text-primary" />
                <h2 className="font-semibold text-foreground">Templates</h2>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => refreshTemplatesMutation.mutate()} disabled={refreshTemplatesMutation.isPending}>
                  {refreshTemplatesMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh Metadata
                </Button>
                <Button onClick={() => generatePreviewsMutation.mutate()} disabled={generatePreviewsMutation.isPending}>
                  {generatePreviewsMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
                  Generate Previews
                </Button>
              </div>
            </div>
            <div className="space-y-3">
              {(templatesQuery.data || []).map((template) => (
                <div key={template.id} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{template.id}</p>
                    <p className="text-muted-foreground">{template.fileName} · {template.sectionCount} sections</p>
                  </div>
                  <span className={template.hasPreview ? 'text-success' : 'text-warning'}>
                    {template.hasPreview ? 'Preview ready' : 'Preview missing'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
