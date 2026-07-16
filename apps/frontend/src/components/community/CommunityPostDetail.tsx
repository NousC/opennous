import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, MessageSquare, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CommunityStatusBadge, CommunityPostStatus } from "./CommunityStatusBadge";
import { CommunityUpvoteButton } from "./CommunityUpvoteButton";
import { CommunityCommentSection, CommunityComment } from "./CommunityCommentSection";
import { CommunityPost } from "./CommunityPostCard";

interface CommunityPostDetailProps {
  post: CommunityPost;
  comments: CommunityComment[];
  currentUserId?: string;
  isAdmin?: boolean;
  onBack: () => void;
  onUpvote: (postId: string) => Promise<void>;
  onAddComment: (content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
  onDeletePost: () => Promise<void>;
  onUpdateStatus?: (status: CommunityPostStatus) => Promise<void>;
  isLoadingComments?: boolean;
}

const TYPE_LABELS = {
  feature_request: 'Feature Request',
  improvement: 'Improvement',
  bug_report: 'Bug Report',
};

const STATUS_OPTIONS: { value: CommunityPostStatus; label: string }[] = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'closed', label: 'Closed' },
];

export function CommunityPostDetail({
  post,
  comments,
  currentUserId,
  isAdmin,
  onBack,
  onUpvote,
  onAddComment,
  onDeleteComment,
  onDeletePost,
  onUpdateStatus,
  isLoadingComments,
}: CommunityPostDetailProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const isOwner = currentUserId === post.user_id;
  const timeAgo = formatDistanceToNow(new Date(post.created_at), { addSuffix: true });

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDeletePost();
    } finally {
      setIsDeleting(false);
    }
  };

  const handleStatusChange = async (status: CommunityPostStatus) => {
    if (!onUpdateStatus) return;
    setIsUpdatingStatus(true);
    try {
      await onUpdateStatus(status);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Back Button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground -ml-2"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to all posts
      </Button>

      {/* Post Content */}
      <div className="flex gap-4">
        {/* Upvote */}
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
        <div className="flex-1 min-w-0 space-y-4">
          {/* Header */}
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-xl font-semibold text-foreground">
                {post.title}
              </h1>
              {isAdmin && onUpdateStatus ? (
                <Select
                  value={post.status}
                  onValueChange={handleStatusChange}
                  disabled={isUpdatingStatus}
                >
                  <SelectTrigger className="w-[140px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <CommunityStatusBadge status={post.status} />
              )}
            </div>

            {/* Meta */}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
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
              <span>{timeAgo}</span>
              <span className="text-gray-300">|</span>
              <span>{TYPE_LABELS[post.type]}</span>
            </div>
          </div>

          {/* Tags */}
          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {post.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="bg-gray-100 text-gray-700 hover:bg-gray-100"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}

          {/* Description */}
          <div className="prose prose-sm max-w-none">
            <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {post.description}
            </p>
          </div>

          {/* Actions */}
          {isOwner && (
            <div className="pt-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete Post
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this post?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. All comments and upvotes will also be deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={isDeleting}
                      className="bg-red-500 hover:bg-red-600"
                    >
                      {isDeleting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          Deleting...
                        </>
                      ) : (
                        "Delete"
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Comments Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            Comments ({comments.length})
          </h2>
        </div>

        <CommunityCommentSection
          comments={comments}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
          currentUserId={currentUserId}
          isLoading={isLoadingComments}
        />
      </div>
    </div>
  );
}
