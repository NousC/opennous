import { useState, useEffect } from "react";
import { Image, Sparkles, Loader2, Trash2, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface BlogGraphicSettings {
  graphicType: 'graphic';
  language: string;
  levelOfDetail: 'concise' | 'normal';
  customInfo?: string;
  colors?: string;
}

const languages = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ru', label: 'Russian' },
];

interface BlogGraphic {
  id: string;
  title: string;
  image_url: string;
  thumbnail_url: string;
  model_name: string;
  created_at: string;
}

interface BlogGraphicsPanelProps {
  articleId: string | null;
  onGraphicSelect?: (graphic: BlogGraphic) => void;
}

export function BlogGraphicsPanel({ articleId, onGraphicSelect }: BlogGraphicsPanelProps) {
  const { session } = useAuth();
  const [graphics, setGraphics] = useState<BlogGraphic[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState<BlogGraphicSettings>({
    graphicType: 'graphic',
    language: 'en',
    levelOfDetail: 'normal',
    customInfo: '',
    colors: '',
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [graphicToDelete, setGraphicToDelete] = useState<BlogGraphic | null>(null);

  useEffect(() => {
    if (articleId) {
      loadGraphics();
    } else {
      setGraphics([]);
    }
  }, [articleId]);

  const loadGraphics = async () => {
    if (!articleId || !session?.access_token) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/blog/articles/${articleId}/graphics`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to load graphics");
      }

      const data = await response.json();
      setGraphics(data.graphics || []);
    } catch (error: any) {
      console.error("Error loading graphics:", error);
      toast.error(error.message || "Failed to load graphics");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateGraphic = async () => {
    if (!articleId || !session?.access_token || !prompt.trim()) {
      toast.error("Please enter a prompt");
      return;
    }

    setGenerating(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/blog/articles/${articleId}/graphics/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ 
            prompt: prompt.trim(),
            settings: settings,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to generate graphic");
      }

      const data = await response.json();
      toast.success("Graphic generated successfully");
      setCreateDialogOpen(false);
      setPrompt("");
      setSettings({
        graphicType: 'graphic',
        language: 'en',
        levelOfDetail: 'normal',
        customInfo: '',
        colors: '',
      });
      await loadGraphics();
    } catch (error: any) {
      console.error("Error generating graphic:", error);
      toast.error(error.message || "Failed to generate graphic");
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteClick = (graphic: BlogGraphic, e: React.MouseEvent) => {
    e.stopPropagation();
    setGraphicToDelete(graphic);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!graphicToDelete || !articleId || !session?.access_token) {
      toast.error("Unable to delete graphic");
      setDeleteDialogOpen(false);
      setGraphicToDelete(null);
      return;
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/blog/articles/${articleId}/graphics/${graphicToDelete.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to delete graphic");
      }

      toast.success("Graphic deleted");
      await loadGraphics();
    } catch (error: any) {
      console.error("Error deleting graphic:", error);
      toast.error(error.message || "Failed to delete graphic");
    } finally {
      setDeleteDialogOpen(false);
      setGraphicToDelete(null);
    }
  };

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
            Graphics
          </Label>
          {articleId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="h-3 w-3 mr-1" />
              Create
            </Button>
          )}
        </div>

        {!articleId ? (
          <div className="text-center py-8 text-sm text-muted-foreground border border-dashed border-border/40 rounded-lg">
            <p>Save the article first to create graphics</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : graphics.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground border border-dashed border-border/40 rounded-lg">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No graphics yet</p>
            <p className="text-xs mt-1">Click Create to generate one</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="grid grid-cols-2 gap-2">
              {graphics.map((graphic) => (
                <Card
                  key={graphic.id}
                  className="cursor-grab active:cursor-grabbing hover:border-primary/50 transition-colors group relative"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/x-blog-graphic", JSON.stringify({
                      id: graphic.id,
                      image_url: graphic.image_url,
                      url: graphic.image_url,
                      alt: graphic.title,
                      title: graphic.title,
                    }));
                    e.dataTransfer.setData("text/plain", graphic.image_url);
                    if (e.currentTarget instanceof HTMLElement) {
                      e.currentTarget.style.opacity = "0.5";
                    }
                  }}
                  onDragEnd={(e) => {
                    if (e.currentTarget instanceof HTMLElement) {
                      e.currentTarget.style.opacity = "1";
                    }
                  }}
                  onClick={() => onGraphicSelect?.(graphic)}
                >
                  <CardContent className="p-0">
                    <div className="relative aspect-square overflow-hidden rounded-t-lg">
                      <img
                        src={graphic.thumbnail_url || graphic.image_url}
                        alt={graphic.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 bg-background/90 backdrop-blur-sm hover:bg-destructive/10 hover:text-destructive"
                          onClick={(e) => handleDeleteClick(graphic, e)}
                          title="Delete graphic"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <div className="p-2">
                      <p className="text-xs font-medium truncate" title={graphic.title}>
                        {graphic.title}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Create Graphic Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        setCreateDialogOpen(open);
        if (!open) {
          setPrompt("");
          setSettings({
            graphicType: 'graphic',
            language: 'en',
            levelOfDetail: 'normal',
            customInfo: '',
            colors: '',
          });
        }
      }}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Graphic</DialogTitle>
            <DialogDescription>
              Enter a prompt and customize settings to generate an AI graphic for your article
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Prompt Input */}
            <div className="space-y-2">
              <Label htmlFor="graphic-prompt">Prompt *</Label>
              <Textarea
                id="graphic-prompt"
                placeholder="e.g., A modern infographic showing key statistics about digital transformation"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Describe what you want the graphic to show
              </p>
            </div>

            {/* Language Selection */}
            <div className="space-y-2">
              <Label htmlFor="language" className="text-sm font-medium">
                Language
              </Label>
              <Select
                value={settings.language}
                onValueChange={(value) =>
                  setSettings({ ...settings, language: value })
                }
              >
                <SelectTrigger id="language">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Level of Detail */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Level of Detail</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={settings.levelOfDetail === 'concise' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() =>
                    setSettings({ ...settings, levelOfDetail: 'concise' })
                  }
                >
                  Concise
                </Button>
                <Button
                  type="button"
                  variant={settings.levelOfDetail === 'normal' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() =>
                    setSettings({ ...settings, levelOfDetail: 'normal' })
                  }
                >
                  Detailed
                </Button>
              </div>
            </div>

            {/* Colors */}
            <div className="space-y-2">
              <Label htmlFor="colors" className="text-sm font-medium">
                Colors <span className="text-xs text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="colors"
                placeholder="e.g., #3B82F6, #10B981, #F59E0B or blue, green, orange"
                value={settings.colors || ''}
                onChange={(e) =>
                  setSettings({ ...settings, colors: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                Specify colors for the graphic (hex codes or color names, comma-separated)
              </p>
            </div>

            {/* Custom Info */}
            <div className="space-y-2">
              <Label htmlFor="customInfo" className="text-sm font-medium">
                Custom Info <span className="text-xs text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="customInfo"
                placeholder="e.g., Focus on sustainability theme, use modern design..."
                value={settings.customInfo || ''}
                onChange={(e) =>
                  setSettings({ ...settings, customInfo: e.target.value })
                }
                rows={3}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Add specific instructions like themes, style requirements, or other preferences
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialogOpen(false);
                setPrompt("");
                setSettings({
                  graphicType: 'graphic',
                  language: 'en',
                  levelOfDetail: 'normal',
                  customInfo: '',
                  colors: '',
                });
              }}
              disabled={generating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateGraphic} disabled={generating || !prompt.trim()}>
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Generating...
                </>
              ) : (
                "Generate"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Graphic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{graphicToDelete?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setDeleteDialogOpen(false);
              setGraphicToDelete(null);
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
