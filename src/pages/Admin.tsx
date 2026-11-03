import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, Images, Loader2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageBody } from '@/components/layout';
import { adminApi } from '@/services/api/admin';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { ProvidersSection } from '@/features/admin/ProvidersSection';
import { RegistrySection } from '@/features/admin/RegistrySection';
import { RunsSection } from '@/features/admin/RunsSection';
import { SourcesSection } from '@/features/admin/SourcesSection';
import { FailuresSection } from '@/features/admin/FailuresSection';
import { CostsSection } from '@/features/admin/CostsSection';

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
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user?.isAdmin) {
    return <Navigate to="/app/resumes" replace />;
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
        <header className="border-b border-border bg-paper px-8 py-5">
          <h1 className="page-title text-ink">Admin</h1>
          <p className="mt-1 text-sm text-ink-3">Templates and maintenance tooling</p>
        </header>

        <PageBody width="data" className="space-y-6 px-8 py-8">
          <section className="surface-card p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="section-title">Templates</h2>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => refreshTemplatesMutation.mutate()} disabled={refreshTemplatesMutation.isPending}>
                  {refreshTemplatesMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh metadata
                </Button>
                <Button onClick={() => generatePreviewsMutation.mutate()} disabled={generatePreviewsMutation.isPending}>
                  {generatePreviewsMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
                  Generate previews
                </Button>
              </div>
            </div>
            <div className="mt-2 border-t border-rule" />
            <div>
              {(templatesQuery.data || []).map((template) => (
                <div key={template.id} className="flex items-center justify-between border-b border-rule py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink">{template.id}</p>
                    <p className="text-ink-3">{template.fileName} · {template.sectionCount} sections</p>
                  </div>
                  <span className={template.hasPreview ? 'text-success' : 'text-warning'}>
                    {template.hasPreview ? 'Preview ready' : 'Preview missing'}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <ProvidersSection />
          <RegistrySection />
          <RunsSection />
          <SourcesSection />
          <FailuresSection />
          <CostsSection />
        </PageBody>
      </div>
  );
}
