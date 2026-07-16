import { cn } from "@/lib/utils";

export type CommunityPostStatus = 'submitted' | 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'closed';

const STATUS_CONFIG: Record<CommunityPostStatus, { label: string; className: string }> = {
  submitted: {
    label: 'Submitted',
    className: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  },
  under_review: {
    label: 'Under Review',
    className: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  },
  planned: {
    label: 'Planned',
    className: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  },
  in_progress: {
    label: 'In Progress',
    className: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  },
  shipped: {
    label: 'Shipped',
    className: 'bg-green-500/10 text-green-600 border-green-500/20',
  },
  closed: {
    label: 'Closed',
    className: 'bg-red-500/10 text-red-500 border-red-500/20',
  },
};

interface CommunityStatusBadgeProps {
  status: CommunityPostStatus;
  className?: string;
}

export function CommunityStatusBadge({ status, className }: CommunityStatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.submitted;

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border",
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  );
}
