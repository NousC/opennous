import { useState } from "react";
import { Loader2, Lightbulb, Wrench, Bug } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type CommunityPostType = 'feature_request' | 'improvement' | 'bug_report';

interface CommunityPostFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    type: CommunityPostType;
    title: string;
    description: string;
    tags: string[];
  }) => Promise<void>;
  availableTags: string[];
  defaultType?: CommunityPostType;
}

const TYPE_OPTIONS = [
  {
    value: 'feature_request' as const,
    label: 'Feature Request',
    description: 'Suggest a new feature or capability',
    icon: Lightbulb,
    iconColor: 'text-amber-500',
  },
  {
    value: 'improvement' as const,
    label: 'Improvement',
    description: 'Enhance an existing feature',
    icon: Wrench,
    iconColor: 'text-blue-500',
  },
  {
    value: 'bug_report' as const,
    label: 'Bug Report',
    description: 'Report something that is broken',
    icon: Bug,
    iconColor: 'text-red-500',
  },
];

export function CommunityPostForm({
  open,
  onOpenChange,
  onSubmit,
  availableTags,
  defaultType,
}: CommunityPostFormProps) {
  const [type, setType] = useState<CommunityPostType | null>(defaultType || null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!type || !title.trim() || !description.trim()) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        type,
        title: title.trim(),
        description: description.trim(),
        tags: selectedTags,
      });

      // Reset form
      setType(null);
      setTitle("");
      setDescription("");
      setSelectedTags([]);
      onOpenChange(false);
    } catch (error) {
      // Error handling is done in parent
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag)
        ? prev.filter((t) => t !== tag)
        : prev.length < 3
        ? [...prev, tag]
        : prev
    );
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setType(null);
      setTitle("");
      setDescription("");
      setSelectedTags([]);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg p-0 border-none shadow-2xl bg-white rounded-xl overflow-hidden">
        <div className="p-6 space-y-5">
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              Submit Feedback
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Share your ideas, suggestions, or report issues to help us improve.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {/* Type Selection */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Type</Label>
              <div className="grid grid-cols-3 gap-2">
                {TYPE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setType(option.value)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all text-center",
                        type === option.value
                          ? "border-black bg-black/5"
                          : "border-border bg-white hover:border-gray-300"
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-5 w-5",
                          type === option.value ? option.iconColor : "text-gray-400"
                        )}
                      />
                      <span
                        className={cn(
                          "text-xs font-medium",
                          type === option.value ? "text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="post-title" className="text-sm font-medium">
                Title
              </Label>
              <Input
                id="post-title"
                placeholder="Brief summary of your feedback"
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, 100))}
                disabled={!type}
                className="text-sm"
              />
              <div className="text-xs text-muted-foreground text-right">
                {title.length}/100
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="post-description" className="text-sm font-medium">
                Description
              </Label>
              <Textarea
                id="post-description"
                placeholder={
                  type === 'feature_request'
                    ? "Describe the feature you'd like to see..."
                    : type === 'improvement'
                    ? "What would you like us to improve..."
                    : type === 'bug_report'
                    ? "Describe the bug and steps to reproduce..."
                    : "Select a type above first..."
                }
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                disabled={!type}
                rows={4}
                className="resize-none text-sm"
              />
              <div className="text-xs text-muted-foreground text-right">
                {description.length}/1000
              </div>
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Tags <span className="text-muted-foreground font-normal">(optional, max 3)</span>
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {availableTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    disabled={!type}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium transition-all border",
                      selectedTags.includes(tag)
                        ? "bg-black text-white border-black"
                        : "bg-gray-50 text-gray-600 border-gray-200 hover:border-gray-300",
                      !type && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button
              variant="ghost"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!type || !title.trim() || !description.trim() || isSubmitting}
              className="bg-black text-white hover:bg-black/90 min-w-[100px]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
