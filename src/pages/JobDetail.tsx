import { useNavigate, useParams } from "react-router-dom";
import { JobDetailPanel } from "@/features/jobs/JobDetailPanel";

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <JobDetailPanel
      jobId={id}
      onBack={() => navigate('/app/jobs')}
    />
  );
}
