import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Send, Loader2, Shield } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface CommunityComment {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_profile_picture_url: string | null;
  content: string;
  is_admin_reply: boolean;
  created_at: string;
  updated_at: string;
}

interface CommunityCommentSectionProps {
  comments: CommunityComment[];
  onAddComment: (content: string) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void>;
  currentUserId?: string;
  isLoading?: boolean;
}

export function CommunityCommentSection({
  comments,
  onAddComment,
  onDeleteComment,
  currentUserId,
  isLoading,
}: CommunityCommentSectionProps) {
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!newComment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onAddComment(newComment.trim());
      setNewComment("");
    } catch (error) {
      // Error handling done in parent
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-4">
      {/* Comment Input */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Textarea
            placeholder="Add a comment..."
            value={newComment}
            onChange={(e) => setNewComment(e.target.value.slice(0, 500))}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
            rows={2}
            className="resize-none text-sm pr-12"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={handleSubmit}
            disabled={!newComment.trim() || isSubmitting}
            className="absolute bottom-2 right-2 h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Comments List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Loading comments...
        </div>
      ) : comments.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No comments yet. Be the first to comment!
        </div>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => {
            const timeAgo = formatDistanceToNow(new Date(comment.created_at), {
              addSuffix: true,
            });
            const canDelete = currentUserId === comment.user_id;

            return (
              <div
                key={comment.id}
                className={cn(
                  "flex gap-3 p-3 rounded-lg",
                  comment.is_admin_reply
                    ? "bg-blue-50/50 border border-blue-100"
                    : "bg-gray-50/50"
                )}
              >
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src={comment.user_profile_picture_url || undefined} />
                  <AvatarFallback className="text-xs bg-gray-200">
                    {comment.user_name?.[0]?.toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {comment.user_name}
                    </span>
                    {comment.is_admin_reply && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
                        <Shield className="h-2.5 w-2.5" />
                        Team
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{timeAgo}</span>
                  </div>

                  <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">
                    {comment.content}
                  </p>

                  {canDelete && onDeleteComment && (
                    <button
                      onClick={() => onDeleteComment(comment.id)}
                      className="text-xs text-muted-foreground hover:text-red-500 mt-2 transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
