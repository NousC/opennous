import { formatDistanceToNow } from "date-fns";
import { MessageSquare } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CommunityStatusBadge, CommunityPostStatus } from "./CommunityStatusBadge";
import { CommunityUpvoteButton } from "./CommunityUpvoteButton";
import { cn } from "@/lib/utils";

export interface CommunityPost {
  id: string;
  type: 'feature_request' | 'improvement' | 'bug_report';
  title: string;
  description: string;
  tags: string[];
  user_id: string;
  user_name: string;
  user_email: string;
  user_profile_picture_url: string | null;
  status: CommunityPostStatus;
  upvote_count: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
  has_upvoted: boolean;
}

interface CommunityPostCardProps {
  post: CommunityPost;
  onClick?: () => void;
  onUpvote: (postId: string) => Promise<void>;
}

export function CommunityPostCard({ post, onClick, onUpvote }: CommunityPostCardProps) {
  const timeAgo = formatDistanceToNow(new Date(post.created_at), { addSuffix: false });

  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex gap-4 p-4 rounded-lg border border-border/60 bg-white hover:border-border hover:shadow-sm transition-all cursor-pointer"
      )}
    >
      {/* Upvote Button */}
      <div className="flex-shrink-0">
        <CommunityUpvoteButton
          postId={post.id}
          upvoteCount={post.upvote_count}
          hasUpvoted={post.has_upvoted}
          onToggle={onUpvote}
          size="md"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title Row */}
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground line-clamp-1 group-hover:text-black">
            {post.title}
          </h3>
          <CommunityStatusBadge status={post.status} />
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
          {post.description}
        </p>

        {/* Meta Row */}
        <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
          {/* User */}
          <div className="flex items-center gap-1.5">
            <Avatar className="h-5 w-5">
              <AvatarImage src={post.user_profile_picture_url || undefined} />
              <AvatarFallback className="text-[10px] bg-gray-100">
                {post.user_name?.[0]?.toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium">{post.user_name}</span>
          </div>

          <span className="text-gray-300">|</span>

          {/* Time */}
          <span>{timeAgo} ago</span>

          {/* Tags */}
          {post.tags && post.tags.length > 0 && (
            <>
              <span className="text-gray-300">|</span>
              <span className="text-blue-600">{post.tags[0]}</span>
            </>
          )}

          {/* Comments */}
          {post.comment_count > 0 && (
            <>
              <span className="text-gray-300">|</span>
              <div className="flex items-center gap-1">
                <MessageSquare className="h-3.5 w-3.5" />
                <span>{post.comment_count}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
