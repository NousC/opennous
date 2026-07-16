import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import type { CommunityPost, CommunityPostType, CommunityPostStatus, CommunityComment } from "@/components/community";

const API_BASE = "/api/community";

interface ListPostsParams {
  type?: CommunityPostType;
  status?: CommunityPostStatus;
  tag?: string;
  sort?: "upvotes" | "recent" | "comments";
  limit?: number;
  offset?: number;
}

interface ListPostsResponse {
  posts: CommunityPost[];
  total: number;
  tags: string[];
}

interface PostDetailResponse {
  post: CommunityPost;
  comments: CommunityComment[];
}

interface CreatePostParams {
  type: CommunityPostType;
  title: string;
  description: string;
  tags: string[];
}

// Fetch posts list
export function useCommunityPosts(params: ListPostsParams = {}) {
  const { session } = useAuth();

  return useQuery({
    queryKey: ["community-posts", params],
    queryFn: async (): Promise<ListPostsResponse> => {
      const searchParams = new URLSearchParams();
      if (params.type) searchParams.set("type", params.type);
      if (params.status) searchParams.set("status", params.status);
      if (params.tag) searchParams.set("tag", params.tag);
      if (params.sort) searchParams.set("sort", params.sort);
      if (params.limit) searchParams.set("limit", String(params.limit));
      if (params.offset) searchParams.set("offset", String(params.offset));

      const response = await fetch(`${API_BASE}/posts?${searchParams}`, {
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to fetch posts");
      }

      return response.json();
    },
    enabled: !!session?.access_token,
    staleTime: 30000, // 30 seconds
  });
}

// Fetch single post with comments
export function useCommunityPost(postId: string | null) {
  const { session } = useAuth();

  return useQuery({
    queryKey: ["community-post", postId],
    queryFn: async (): Promise<PostDetailResponse> => {
      if (!postId) throw new Error("No post ID");

      const response = await fetch(`${API_BASE}/posts/${postId}`, {
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to fetch post");
      }

      return response.json();
    },
    enabled: !!session?.access_token && !!postId,
    staleTime: 0, // Always consider data stale to ensure fresh fetches
    refetchOnMount: true,
  });
}

// Create new post
export function useCreateCommunityPost() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreatePostParams): Promise<{ post: CommunityPost }> => {
      const response = await fetch(`${API_BASE}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to create post");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
      toast.success("Your feedback has been submitted!");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to submit feedback");
    },
  });
}

// Delete post
export function useDeleteCommunityPost() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string): Promise<void> => {
      const response = await fetch(`${API_BASE}/posts/${postId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to delete post");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
      toast.success("Post deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete post");
    },
  });
}

// Toggle upvote
export function useToggleCommunityUpvote() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: string): Promise<{ has_upvoted: boolean; upvote_count: number }> => {
      const response = await fetch(`${API_BASE}/posts/${postId}/upvote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to toggle upvote");
      }

      return response.json();
    },
    onSuccess: (_, postId) => {
      // Invalidate both list and detail queries
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
      queryClient.invalidateQueries({ queryKey: ["community-post", postId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to upvote");
    },
  });
}

// Add comment
export function useAddCommunityComment() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      postId,
      content,
    }: {
      postId: string;
      content: string;
    }): Promise<{ comment: CommunityComment }> => {
      const response = await fetch(`${API_BASE}/posts/${postId}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to add comment");
      }

      return response.json();
    },
    onSuccess: (_, { postId }) => {
      queryClient.invalidateQueries({ queryKey: ["community-post", postId] });
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add comment");
    },
  });
}

// Delete comment
export function useDeleteCommunityComment() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      commentId,
      postId,
    }: {
      commentId: string;
      postId: string;
    }): Promise<void> => {
      const response = await fetch(`${API_BASE}/comments/${commentId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to delete comment");
      }
    },
    onSuccess: (_, { postId }) => {
      queryClient.invalidateQueries({ queryKey: ["community-post", postId] });
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
      toast.success("Comment deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete comment");
    },
  });
}

// Update post status (admin only)
export function useUpdateCommunityPostStatus() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      postId,
      status,
    }: {
      postId: string;
      status: CommunityPostStatus;
    }): Promise<{ post: CommunityPost }> => {
      const response = await fetch(`${API_BASE}/posts/${postId}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.error || "Failed to update status");
      }

      return response.json();
    },
    onSuccess: (data, { postId }) => {
      // Update the post detail cache directly with the new status
      queryClient.setQueryData(["community-post", postId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          post: { ...old.post, status: data.post.status },
        };
      });
      // Also invalidate and refetch both queries to ensure sync
      queryClient.invalidateQueries({ queryKey: ["community-post", postId] });
      queryClient.invalidateQueries({ queryKey: ["community-posts"] });
      toast.success("Status updated");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update status");
    },
  });
}
