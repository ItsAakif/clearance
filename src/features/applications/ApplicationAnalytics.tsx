import { Card } from '@/components/ui/card';
import { BarChart3, MessageSquare, FileCheck, Percent, Gauge } from 'lucide-react';
import { computeApplicationAnalytics } from './applicationAnalyticsData';
import type { Application } from '@/services/api';

interface Props {
  apps: Application[];
}

export function ApplicationAnalytics({ apps }: Props) {
  const data = computeApplicationAnalytics(apps);

  const metrics = [
    { label: 'Applications', value: data.applications, icon: BarChart3 },
    { label: 'Interviews', value: data.interviews, icon: MessageSquare },
    { label: 'Offers', value: data.offers, icon: FileCheck },
    { label: 'Response rate', value: data.responseRate === null ? '-' : `${data.responseRate}%`, icon: Percent },
    { label: 'Avg. match score', value: data.averageMatchScore === null ? '-' : data.averageMatchScore, icon: Gauge },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {metrics.map((m) => (
        <Card key={m.label} className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <m.icon className="h-4 w-4" />
            <span className="text-xs">{m.label}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-foreground">{m.value}</p>
        </Card>
      ))}
    </div>
  );
}
