import { useState } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface CommunityUpvoteButtonProps {
  postId: string;
  upvoteCount: number;
  hasUpvoted: boolean;
  onToggle: (postId: string) => Promise<void>;
  size?: "sm" | "md";
}

export function CommunityUpvoteButton({
  postId,
  upvoteCount,
  hasUpvoted,
  onToggle,
  size = "md",
}: CommunityUpvoteButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [optimisticUpvoted, setOptimisticUpvoted] = useState(hasUpvoted);
  const [optimisticCount, setOptimisticCount] = useState(upvoteCount);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLoading) return;

    // Optimistic update
    const wasUpvoted = optimisticUpvoted;
    setOptimisticUpvoted(!wasUpvoted);
    setOptimisticCount(wasUpvoted ? optimisticCount - 1 : optimisticCount + 1);
    setIsLoading(true);

    try {
      await onToggle(postId);
    } catch (error) {
      // Rollback on error
      setOptimisticUpvoted(wasUpvoted);
      setOptimisticCount(wasUpvoted ? optimisticCount : optimisticCount - 1);
    } finally {
      setIsLoading(false);
    }
  };

  const isSmall = size === "sm";

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      disabled={isLoading}
      className={cn(
        "flex flex-col items-center gap-0 transition-all",
        isSmall ? "h-12 w-10 p-0" : "h-14 w-12 p-0",
        optimisticUpvoted
          ? "bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200"
          : "bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200"
      )}
    >
      <ChevronUp
        className={cn(
          "transition-transform",
          isSmall ? "h-4 w-4" : "h-5 w-5",
          optimisticUpvoted && "text-blue-600"
        )}
      />
      <span className={cn("font-semibold", isSmall ? "text-xs" : "text-sm")}>
        {optimisticCount}
      </span>
    </Button>
  );
}
