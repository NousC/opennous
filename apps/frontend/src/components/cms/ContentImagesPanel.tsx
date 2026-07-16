import { useState, useEffect, useRef } from "react";
import { Image, Loader2, Trash2, Upload, X, Edit2, Save, Users, Building2, Briefcase } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ContentImage {
  id: string;
  title: string | null;
  image_url: string;
  storage_path: string;
  section_types: string[];
  aspect_ratio: string | null;
  active: boolean;
  created_at: string;
}

/**
 * SIMPLIFIED 3-CATEGORY SYSTEM for content images
 *
 * 1. About Us - Company story, mission, values, why us pages
 * 2. Team - Team members, leadership, staff pages
 * 3. Service - ALL OTHER PAGES (problem, solution, scope, case study, pricing, etc.)
 *
 * The "Service" category is the universal fallback.
 * Most content images should be tagged with "Service" since they work across multiple sections.
 */
const SECTION_TYPE_OPTIONS = [
  {
    value: 'about_us',
    label: 'About Us',
    description: 'Company story, mission, values, why us',
    icon: <Building2 className="h-4 w-4" />
  },
  {
    value: 'team',
    label: 'Team',
    description: 'Team members, leadership, staff',
    icon: <Users className="h-4 w-4" />
  },
  {
    value: 'service',
    label: 'Service (All Other Pages)',
    description: 'Problem, solution, scope, case study, pricing, methodology, testimonials, etc.',
    icon: <Briefcase className="h-4 w-4" />
  },
];

// Helper to get friendly label for section type
const getSectionTypeLabel = (value: string): string => {
  // Handle new simplified categories
  const option = SECTION_TYPE_OPTIONS.find(o => o.value === value);
  if (option) return option.label;

  // Handle legacy categories (for existing images in DB)
  const legacyLabels: Record<string, string> = {
    'general': 'Service',
    'services': 'Service',
    'testimonial': 'Service',
    'case_study': 'Service',
    'hero': 'Service',
    'methodology': 'Service',
    'contact': 'Service',
    'problem': 'Service',
    'solution': 'Service',
    'benefits': 'Service',
    'pricing': 'Service',
    'faq': 'Service',
    'features': 'Service',
  };
  return legacyLabels[value] || value;
};

export function ContentImagesPanel() {
  const { session } = useAuth();
  const [images, setImages] = useState<ContentImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [imageToDelete, setImageToDelete] = useState<ContentImage | null>(null);
  const [editingImage, setEditingImage] = useState<ContentImage | null>(null);

  // Upload state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);

  // Upload form state - simplified (single dropdown)
  const [uploadSectionType, setUploadSectionType] = useState<string>('service');

  // Edit form state - simplified (single dropdown)
  const [editSectionType, setEditSectionType] = useState<string>('service');
  const [editAspectRatio, setEditAspectRatio] = useState<string>('landscape');
  const [editActive, setEditActive] = useState(true);

  useEffect(() => {
    if (session?.access_token) {
      loadImages();
    }
  }, [session]);

  const loadImages = async () => {
    if (!session?.access_token) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/content-images`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to load content images");
      }

      const data = await response.json();
      setImages(data.images || []);
    } catch (error: any) {
      console.error("Error loading content images:", error);
      toast.error(error.message || "Failed to load content images");
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const resetUploadForm = () => {
    setUploadFile(null);
    setUploadPreview(null);
    setUploadSectionType('service'); // Default to service (universal fallback)
    setUploadDialogOpen(false);
    if (uploadFileInputRef.current) {
      uploadFileInputRef.current.value = '';
    }
  };

  const handleUploadSubmit = async () => {
    if (!uploadFile || !session?.access_token) {
      toast.error("Please select an image");
      return;
    }

    setUploadingFile(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";

      // Upload the image first
      const formData = new FormData();
      formData.append('image', uploadFile);
      const uploadResponse = await fetch(
        `${apiUrl}/api/admin/content-images/upload`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload image");
      }

      const uploadData = await uploadResponse.json();

      // Create the content image record
      const createResponse = await fetch(
        `${apiUrl}/api/admin/content-images`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            imageUrl: uploadData.url,
            storagePath: uploadData.path,
            section_types: [uploadSectionType], // Send as array for DB
          }),
        }
      );

      if (!createResponse.ok) {
        throw new Error("Failed to create content image");
      }

      toast.success("Content image uploaded successfully");
      resetUploadForm();
      await loadImages();
    } catch (error: any) {
      console.error("Error uploading content image:", error);
      toast.error(error.message || "Failed to upload content image");
    } finally {
      setUploadingFile(false);
    }
  };

  const handleEditClick = (image: ContentImage) => {
    setEditingImage(image);
    // Get the first section type, or default to 'service'
    const firstType = image.section_types?.[0] || 'service';
    // Map legacy types to new simplified types
    const mappedType = ['about_us', 'team', 'service'].includes(firstType)
      ? firstType
      : 'service';
    setEditSectionType(mappedType);
    setEditAspectRatio(image.aspect_ratio || 'landscape');
    setEditActive(image.active);
  };

  const handleSaveEdit = async () => {
    if (!editingImage || !session?.access_token) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/content-images/${editingImage.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            section_types: [editSectionType], // Send as array for DB
            aspect_ratio: editAspectRatio,
            active: editActive,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to update content image");
      }

      toast.success("Content image updated");
      setEditingImage(null);
      await loadImages();
    } catch (error: any) {
      console.error("Error updating content image:", error);
      toast.error(error.message || "Failed to update content image");
    }
  };

  const handleDeleteClick = (image: ContentImage) => {
    setImageToDelete(image);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!imageToDelete || !session?.access_token) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(
        `${apiUrl}/api/admin/content-images/${imageToDelete.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to delete content image");
      }

      toast.success("Content image deleted");
      setDeleteDialogOpen(false);
      setImageToDelete(null);
      await loadImages();
    } catch (error: any) {
      console.error("Error deleting content image:", error);
      toast.error(error.message || "Failed to delete content image");
    }
  };

  const renderSectionTypeDropdown = (isUpload: boolean) => {
    const value = isUpload ? uploadSectionType : editSectionType;
    const onChange = isUpload ? setUploadSectionType : setEditSectionType;

    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select section type" />
        </SelectTrigger>
        <SelectContent>
          {SECTION_TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex items-center gap-2">
                {option.icon}
                <div>
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground text-xs ml-2">
                    - {option.description}
                  </span>
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Content Images</h2>
          <p className="text-sm text-muted-foreground">
            Stock images automatically inserted into :::image blocks during document generation.
            <br />
            <span className="text-xs">3 categories: About Us, Team, and Service (all other pages).</span>
          </p>
        </div>
        <Button onClick={() => setUploadDialogOpen(true)}>
          <Upload className="h-4 w-4 mr-2" />
          Upload Image
        </Button>
      </div>

      {/* Images Grid */}
      <ScrollArea className="h-[calc(100vh-300px)]">
        {images.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Image className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm font-medium">No content images yet</p>
            <p className="text-xs mt-1">
              Upload images to automatically fill :::image blocks in generated documents.
            </p>
            <p className="text-xs mt-2 max-w-md mx-auto">
              Tip: Start with "Service" images since they work for all pages.
              Add specific "About Us" and "Team" images if you want different visuals for those sections.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {images.map((image) => (
              <Card key={image.id} className={`group relative overflow-hidden ${!image.active ? 'opacity-50' : ''}`}>
                <CardContent className="p-0">
                  <div className="aspect-video relative">
                    <img
                      src={image.image_url}
                      alt={image.title || 'Content image'}
                      className="w-full h-full object-cover"
                    />
                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => handleEditClick(image)}>
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDeleteClick(image)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="p-3">
                    {image.title && (
                      <p className="text-sm font-medium truncate mb-2">{image.title}</p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {/* De-duplicate labels since legacy types all map to "Service" */}
                      {[...new Set(image.section_types?.map(s => getSectionTypeLabel(s)) || [])].slice(0, 3).map((label) => (
                        <Badge key={label} variant="secondary" className="text-xs">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={(open) => {
        if (!open) resetUploadForm();
        setUploadDialogOpen(open);
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Content Image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Image Upload */}
            <div>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                ref={uploadFileInputRef}
                className="hidden"
              />
              {uploadPreview ? (
                <div className="relative aspect-video rounded-lg overflow-hidden border">
                  <img src={uploadPreview} alt="Preview" className="w-full h-full object-cover" />
                  <Button
                    size="icon"
                    variant="destructive"
                    className="absolute top-2 right-2 h-6 w-6"
                    onClick={() => {
                      setUploadFile(null);
                      setUploadPreview(null);
                      if (uploadFileInputRef.current) uploadFileInputRef.current.value = '';
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div
                  className="aspect-video rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => uploadFileInputRef.current?.click()}
                >
                  <div className="text-center">
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">Click to upload image</p>
                  </div>
                </div>
              )}
            </div>

            {/* Section Type Dropdown */}
            <div className="space-y-2">
              <Label>Suitable Sections</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Which pages should this image appear on?
              </p>
              {renderSectionTypeDropdown(true)}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetUploadForm} disabled={uploadingFile}>Cancel</Button>
            <Button onClick={handleUploadSubmit} disabled={!uploadFile || uploadingFile}>
              {uploadingFile ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Uploading...</> : <><Upload className="h-4 w-4 mr-2" /> Upload</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingImage} onOpenChange={(open) => !open && setEditingImage(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Content Image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Preview */}
            {editingImage && (
              <div className="aspect-video rounded-lg overflow-hidden border">
                <img src={editingImage.image_url} alt="Preview" className="w-full h-full object-cover" />
              </div>
            )}

            {/* Section Type Dropdown */}
            <div className="space-y-2">
              <Label>Suitable Sections</Label>
              {renderSectionTypeDropdown(false)}
            </div>

            {/* Aspect Ratio Dropdown */}
            <div className="space-y-2">
              <Label>Aspect Ratio</Label>
              <Select value={editAspectRatio} onValueChange={setEditAspectRatio}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="landscape">Landscape (wider than tall)</SelectItem>
                  <SelectItem value="portrait">Portrait (taller than wide)</SelectItem>
                  <SelectItem value="square">Square</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Landscape images are preferred for full-bleed layouts
              </p>
            </div>

            {/* Active Toggle */}
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-active">Active</Label>
              <Switch
                id="edit-active"
                checked={editActive}
                onCheckedChange={setEditActive}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingImage(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit}>
              <Save className="h-4 w-4 mr-2" /> Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Content Image?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this image. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
