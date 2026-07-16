import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, X, ChevronUp, ChevronDown, Plus, Search, FileText, Calendar, Image as ImageIcon, Trash2, Play, BookOpen, Briefcase, Video, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import { BlogContentEditor } from "@/components/cms/BlogContentEditor";
import { BlogGraphicsPanel } from "@/components/cms/BlogGraphicsPanel";
import { format } from "date-fns";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";

type CollectionType = 'blog' | 'tutorials' | 'use-cases' | 'inside';

// Coffee Shop hub categories — keep in sync with the nous-site resource page.
const CMS_CATEGORIES = [
  { value: 'get-started', label: 'Get Started' },
  { value: 'gtm', label: 'GTM' },
  { value: 'skills', label: 'Skills' },
  { value: 'guides', label: 'Guides (hidden)' },
  { value: 'blog', label: 'Blog' },
  { value: 'resources', label: 'Resources' },
] as const;

interface BlogArticle {
  id: string;
  title: string;
  slug: string;
  meta_description: string;
  cover_image_url: string | null;
  content: any;
  status: 'draft' | 'published';
  featured: boolean;
  is_guide: boolean;
  article_type?: 'article' | 'announcement' | 'founder';
  category?: string;
  video_url?: string | null;
  intro_text?: string | null;
  related_workflow_slugs?: string[];
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InsideAnnouncement {
  id: string;
  title: string;
  slug: string;
  meta_description: string;
  intro_text: string | null;
  video_url: string | null;
  cover_image_url: string | null;
  content: any;
  status: 'draft' | 'published';
  article_type: 'announcement';
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Tutorial {
  id: string;
  title: string;
  slug: string;
  description: string;
  duration: string | null;
  video_url: string | null;
  video_file_url: string | null;
  status: 'draft' | 'published';
  order_index: number;
  created_at: string;
  updated_at: string;
}

interface UseCase {
  id: string;
  title: string;
  slug: string;
  description: string;
  content: any;
  status: 'draft' | 'published';
  order_index: number;
  created_at: string;
  updated_at: string;
}

export default function AdminCMS() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [collectionType, setCollectionType] = useState<CollectionType>('blog');
  const [articles, setArticles] = useState<BlogArticle[]>([]);
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [insideAnnouncements, setInsideAnnouncements] = useState<InsideAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedArticle, setSelectedArticle] = useState<BlogArticle | null>(null);
  const [selectedTutorial, setSelectedTutorial] = useState<Tutorial | null>(null);
  const [selectedUseCase, setSelectedUseCase] = useState<UseCase | null>(null);
  const [selectedInside, setSelectedInside] = useState<InsideAnnouncement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);

  const [formData, setFormData] = useState({
    // Blog fields
    title: "",
    slug: "",
    meta_description: "",
    cover_image_url: "",
    featured: false,
    is_guide: false,
    article_type: 'article' as 'article' | 'founder',
    category: 'blog' as string,
    content: {},
    date: format(new Date(), "dd.MM.yyyy"),
    // Tutorial fields
    description: "",
    duration: "",
    video_url: "",
    video_file_url: "",
    order_index: 0,
    // Inside Announcement fields
    intro_text: "",
    // Related workflow templates
    related_workflow_slugs: [] as string[],
  });

  const coverImageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Function to generate slug from title
  const generateSlug = (title: string): string => {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
  };

  const loadCurrentCollection = async () => {
    if (!session) {
      setLoading(false);
      return;
    }

    switch (collectionType) {
      case 'blog':
        await loadArticles();
        break;
      case 'tutorials':
        await loadTutorials();
        break;
      case 'use-cases':
        await loadUseCases();
        break;
      case 'inside':
        await loadInsideAnnouncements();
        break;
    }
  };

  useEffect(() => {
    let mounted = true;
    
    const loadData = async () => {
      if (session) {
        try {
          await loadCurrentCollection();
        } catch (error) {
          console.error('[AdminCMS] Error loading collection:', error);
          if (mounted) {
            setLoading(false);
          }
        }
      } else {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    
    loadData();
    
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, collectionType]);

  // Auto-generate slug from title when title changes (only if slug hasn't been manually edited)
  useEffect(() => {
    if (formData.title && !slugManuallyEdited && !selectedArticle && !selectedTutorial && !selectedUseCase) {
      const autoSlug = generateSlug(formData.title);
      setFormData(prev => ({ ...prev, slug: autoSlug }));
    }
  }, [formData.title, slugManuallyEdited, selectedArticle, selectedTutorial, selectedUseCase]);

  const loadArticles = async () => {
    if (!session) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      // Filter to only show articles (not announcements)
      const response = await fetch(`${apiUrl}/api/admin/blog/articles?article_type=article`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let errorData = {};
        try {
          errorData = JSON.parse(text);
        } catch (e) {
          console.error("Failed to load articles - non-JSON response:", text);
          throw new Error(`Failed to load articles: ${response.status} ${response.statusText}`);
        }
        console.error("Failed to load articles:", response.status, errorData);
        throw new Error(errorData.detail || errorData.message || `Failed to load articles: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      setArticles(data.articles || []);
    } catch (error: any) {
      console.error("Error loading articles:", error);
      toast.error(error.message || "Failed to load articles");
      setArticles([]);
    } finally {
      setLoading(false);
    }
  };

  const loadTutorials = async () => {
    if (!session) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/admin/resources/tutorials`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let errorData = {};
        try {
          errorData = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to load tutorials: ${response.status} ${response.statusText}`);
        }
        throw new Error(errorData.detail || errorData.message || `Failed to load tutorials: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      setTutorials(data.tutorials || []);
    } catch (error: any) {
      console.error("Error loading tutorials:", error);
      toast.error(error.message || "Failed to load tutorials");
      setTutorials([]);
    } finally {
      setLoading(false);
    }
  };

  const loadUseCases = async () => {
    if (!session) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/admin/resources/use-cases`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let errorData = {};
        try {
          errorData = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to load use cases: ${response.status} ${response.statusText}`);
        }
        throw new Error(errorData.detail || errorData.message || `Failed to load use cases: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      setUseCases(data.useCases || []);
    } catch (error: any) {
      console.error("Error loading use cases:", error);
      toast.error(error.message || "Failed to load use cases");
      setUseCases([]);
    } finally {
      setLoading(false);
    }
  };

  const loadInsideAnnouncements = async () => {
    if (!session) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/admin/blog/articles?article_type=announcement`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let errorData = {};
        try {
          errorData = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to load announcements: ${response.status} ${response.statusText}`);
        }
        throw new Error(errorData.detail || errorData.message || `Failed to load announcements: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      setInsideAnnouncements(data.articles || []);
    } catch (error: any) {
      console.error("Error loading inside announcements:", error);
      toast.error(error.message || "Failed to load announcements");
      setInsideAnnouncements([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNew = () => {
    setFormData({
      title: "",
      slug: "",
      meta_description: "",
      cover_image_url: "",
      featured: false,
      category: 'blog',
      content: {},
      date: format(new Date(), "dd.MM.yyyy"),
      description: "",
      duration: "",
      video_url: "",
      video_file_url: "",
      order_index: 0,
      intro_text: "",
      related_workflow_slugs: [],
    });
    setSelectedArticle(null);
    setSelectedTutorial(null);
    setSelectedUseCase(null);
    setSelectedInside(null);
    setSlugManuallyEdited(false);
    setIsEditing(true);
  };

  const handleSelectArticle = (article: BlogArticle) => {
    setSelectedArticle(article);
    setFormData({
      title: article.title,
      slug: article.slug,
      meta_description: article.meta_description || "",
      cover_image_url: article.cover_image_url || "",
      featured: article.featured,
      is_guide: article.is_guide || false,
      article_type: (article.article_type === 'founder' ? 'founder' : 'article') as 'article' | 'founder',
      category: article.category || 'blog',
      content: article.content || {},
      date: article.published_at
        ? format(new Date(article.published_at), "dd.MM.yyyy")
        : format(new Date(article.created_at), "dd.MM.yyyy"),
      description: "",
      duration: "",
      video_url: "",
      video_file_url: "",
      order_index: 0,
      intro_text: "",
      related_workflow_slugs: article.related_workflow_slugs || [],
    });
    setSlugManuallyEdited(true);
    setIsEditing(true);
  };

  const handleSelectInside = (announcement: InsideAnnouncement) => {
    setSelectedInside(announcement);
    setFormData({
      title: announcement.title,
      slug: announcement.slug,
      meta_description: announcement.meta_description || "",
      cover_image_url: announcement.cover_image_url || "",
      intro_text: announcement.intro_text || "",
      video_url: announcement.video_url || "",
      content: announcement.content || {},
      date: announcement.published_at
        ? format(new Date(announcement.published_at), "dd.MM.yyyy")
        : format(new Date(announcement.created_at), "dd.MM.yyyy"),
      featured: false,
      is_guide: false,
      description: "",
      duration: "",
      video_file_url: "",
      order_index: 0,
    });
    setSlugManuallyEdited(true);
    setIsEditing(true);
  };

  const handleSelectTutorial = (tutorial: Tutorial) => {
    setSelectedTutorial(tutorial);
    setFormData({
      title: tutorial.title,
      slug: tutorial.slug,
      description: tutorial.description,
      duration: tutorial.duration || "",
      video_url: tutorial.video_url || "",
      video_file_url: tutorial.video_file_url || "",
      order_index: tutorial.order_index || 0,
      meta_description: "",
      cover_image_url: "",
      featured: false,
      content: {},
      date: format(new Date(), "dd.MM.yyyy"),
      intro_text: "",
    });
    setSlugManuallyEdited(true);
    setIsEditing(true);
  };

  const handleSelectUseCase = (useCase: UseCase) => {
    setSelectedUseCase(useCase);
    setFormData({
      title: useCase.title,
      slug: useCase.slug,
      description: useCase.description,
      content: useCase.content || {},
      order_index: useCase.order_index || 0,
      meta_description: "",
      cover_image_url: "",
      featured: false,
      duration: "",
      video_url: "",
      video_file_url: "",
      date: format(new Date(), "dd.MM.yyyy"),
      intro_text: "",
    });
    setSlugManuallyEdited(true);
    setIsEditing(true);
  };

  const handleSaveDraft = async () => {
    if (!session) return;

    if (!formData.title.trim() || !formData.slug.trim()) {
      toast.error("Title and slug are required");
      return;
    }

    setSaving(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      let endpoint = '';
      let payload: any = {};
      let selectedItem: any = null;

      if (collectionType === 'blog') {
        endpoint = selectedArticle
          ? `${apiUrl}/api/admin/blog/articles/${selectedArticle.id}`
          : `${apiUrl}/api/admin/blog/articles`;
        payload = {
          title: formData.title,
          slug: formData.slug,
          meta_description: formData.meta_description,
          cover_image_url: formData.cover_image_url || null,
          content: formData.content,
          featured: formData.featured,
          is_guide: formData.is_guide || false,
          article_type: formData.article_type || 'article',
          category: formData.category || 'blog',
          status: 'draft',
          related_workflow_slugs: formData.related_workflow_slugs || [],
        };
        selectedItem = selectedArticle;
      } else if (collectionType === 'tutorials') {
        endpoint = selectedTutorial
          ? `${apiUrl}/api/admin/resources/tutorials/${selectedTutorial.id}`
          : `${apiUrl}/api/admin/resources/tutorials`;
        payload = {
          title: formData.title,
          slug: formData.slug,
          description: formData.description,
          duration: formData.duration || null,
          video_url: formData.video_url || null,
          video_file_url: formData.video_file_url || null,
          order_index: formData.order_index || 0,
          status: 'draft',
        };
        selectedItem = selectedTutorial;
      } else if (collectionType === 'use-cases') {
        endpoint = selectedUseCase
          ? `${apiUrl}/api/admin/resources/use-cases/${selectedUseCase.id}`
          : `${apiUrl}/api/admin/resources/use-cases`;
        payload = {
          title: formData.title,
          slug: formData.slug,
          description: formData.description,
          content: formData.content || {},
          order_index: formData.order_index || 0,
          status: 'draft',
        };
        selectedItem = selectedUseCase;
      } else if (collectionType === 'inside') {
        endpoint = selectedInside
          ? `${apiUrl}/api/admin/blog/articles/${selectedInside.id}`
          : `${apiUrl}/api/admin/blog/articles`;
        payload = {
          title: formData.title,
          slug: formData.slug,
          meta_description: formData.meta_description,
          cover_image_url: formData.cover_image_url || null,
          intro_text: formData.intro_text || null,
          video_url: formData.video_url || null,
          content: formData.content || {},
          article_type: 'announcement',
          status: 'draft',
        };
        selectedItem = selectedInside;
      }

      const method = selectedItem ? 'PATCH' : 'POST';
      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        let error = {};
        try {
          error = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to save: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || "Failed to save");
      }

      const text = await response.text();
      const data = JSON.parse(text);
      toast.success("Draft saved successfully");
      
      // Reload current collection and select the saved item
      await loadCurrentCollection();
      const savedItem = data.article || data.tutorial || data.useCase;
      if (savedItem) {
        if (collectionType === 'blog') {
          handleSelectArticle(savedItem);
        } else if (collectionType === 'tutorials') {
          setSelectedTutorial(savedItem);
          setIsEditing(true);
        } else if (collectionType === 'use-cases') {
          setSelectedUseCase(savedItem);
          setIsEditing(true);
        } else if (collectionType === 'inside') {
          handleSelectInside(savedItem);
        }
      }
    } catch (error: any) {
      console.error("Error saving draft:", error);
      toast.error(error.message || "Failed to save draft");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!session) return;

    if (!formData.title.trim() || !formData.slug.trim()) {
      toast.error("Title and slug are required");
      return;
    }

    setPublishing(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";

      if (collectionType === 'blog' || collectionType === 'inside') {
        // Blog and Inside Announcements use the same blog_articles table
        const payload = collectionType === 'inside' ? {
          title: formData.title,
          slug: formData.slug,
          meta_description: formData.meta_description,
          cover_image_url: formData.cover_image_url || null,
          intro_text: formData.intro_text || null,
          video_url: formData.video_url || null,
          content: formData.content || {},
          article_type: 'announcement',
          status: 'published',
        } : {
          title: formData.title,
          slug: formData.slug,
          meta_description: formData.meta_description,
          cover_image_url: formData.cover_image_url || null,
          content: formData.content,
          featured: formData.featured,
          is_guide: formData.is_guide || false,
          article_type: formData.article_type || 'article',
          category: formData.category || 'blog',
          status: 'published',
          related_workflow_slugs: formData.related_workflow_slugs || [],
        };

        const selectedItem = collectionType === 'inside' ? selectedInside : selectedArticle;
        let articleId = selectedItem?.id;

        if (selectedItem) {
          const updateResponse = await fetch(`${apiUrl}/api/admin/blog/articles/${selectedItem.id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(payload),
          });

          if (!updateResponse.ok) {
            const text = await updateResponse.text();
            let error = {};
            try {
              error = JSON.parse(text);
            } catch (e) {
              throw new Error(`Failed to update: ${updateResponse.status} ${updateResponse.statusText}`);
            }
            throw new Error(error.detail || error.message || "Failed to update");
          }

          articleId = selectedArticle.id;
        } else {
          const createResponse = await fetch(`${apiUrl}/api/admin/blog/articles`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(payload),
          });

          if (!createResponse.ok) {
            const text = await createResponse.text();
            let error = {};
            try {
              error = JSON.parse(text);
            } catch (e) {
              throw new Error(`Failed to create: ${createResponse.status} ${createResponse.statusText}`);
            }
            throw new Error(error.detail || error.message || "Failed to create");
          }

          const text = await createResponse.text();
          const createData = JSON.parse(text);
          articleId = createData.article.id;
        }

        // Then publish it (this ensures published_at is set even if article was created with status: 'published')
        const publishResponse = await fetch(`${apiUrl}/api/admin/blog/articles/${articleId}/publish`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (!publishResponse.ok) {
          const text = await publishResponse.text();
          let error = {};
          try {
            error = JSON.parse(text);
          } catch (e) {
            console.error('[PUBLISH_ERROR] Non-JSON response:', text);
            throw new Error(`Failed to publish: ${publishResponse.status} ${publishResponse.statusText}`);
          }
          console.error('[PUBLISH_ERROR]', error);
          throw new Error(error.detail || error.message || "Failed to publish");
        }

        const publishText = await publishResponse.text();
        let publishData = {};
        try {
          publishData = JSON.parse(publishText);
        } catch (e) {
          console.error('[PUBLISH_ERROR] Failed to parse publish response:', publishText);
        }

        // Verify the article was actually published
        if (publishData.article && publishData.article.status === 'published') {
          toast.success(collectionType === 'inside' ? "Announcement published successfully" : "Article published successfully");
          // Reload collection to refresh the list
          if (collectionType === 'inside') {
            await loadInsideAnnouncements();
            setSelectedInside(null);
          } else {
            await loadArticles();
            setSelectedArticle(null);
          }
          // Reset form and close editor
          setIsEditing(false);
          setFormData({
            title: '',
            slug: '',
            meta_description: '',
            cover_image_url: null,
            content: null,
            featured: false,
            is_guide: false,
            date: '',
            intro_text: '',
            video_url: '',
            related_workflow_slugs: [],
          });
        } else {
          throw new Error(collectionType === 'inside' ? "Announcement was not published successfully" : "Article was not published successfully");
        }
      } else {
        // For tutorials and use cases, just update status to published
        let endpoint = '';
        let payload: any = {};

        if (collectionType === 'tutorials') {
          endpoint = selectedTutorial
            ? `${apiUrl}/api/admin/resources/tutorials/${selectedTutorial.id}`
            : `${apiUrl}/api/admin/resources/tutorials`;
          payload = {
            title: formData.title,
            slug: formData.slug,
            description: formData.description,
            duration: formData.duration || null,
            video_url: formData.video_url || null,
            video_file_url: formData.video_file_url || null,
            order_index: formData.order_index || 0,
            status: 'published',
          };
        } else if (collectionType === 'use-cases') {
          endpoint = selectedUseCase
            ? `${apiUrl}/api/admin/resources/use-cases/${selectedUseCase.id}`
            : `${apiUrl}/api/admin/resources/use-cases`;
          payload = {
            title: formData.title,
            slug: formData.slug,
            description: formData.description,
            content: formData.content || {},
            order_index: formData.order_index || 0,
            status: 'published',
          };
        }

        const method = (selectedTutorial || selectedUseCase) ? 'PATCH' : 'POST';
        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text();
          let error = {};
          try {
            error = JSON.parse(text);
          } catch (e) {
            throw new Error(`Failed to publish: ${response.status} ${response.statusText}`);
          }
          throw new Error(error.detail || error.message || "Failed to publish");
        }

        toast.success("Published successfully");
        await loadCurrentCollection();
      }
    } catch (error: any) {
      console.error("Error publishing:", error);
      toast.error(error.message || "Failed to publish");
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    const selectedItem = collectionType === 'inside' ? selectedInside : selectedArticle;
    if (!session || !selectedItem) return;

    setUnpublishing(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";

      const response = await fetch(`${apiUrl}/api/admin/blog/articles/${selectedItem.id}/unpublish`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let error = {};
        try {
          error = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to unpublish: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || "Failed to unpublish");
      }

      const data = await response.json();

      if (data.article && data.article.status === 'draft') {
        toast.success(collectionType === 'inside' ? "Announcement unpublished successfully" : "Article unpublished successfully");
        if (collectionType === 'inside') {
          await loadInsideAnnouncements();
          setSelectedInside(data.article);
        } else {
          await loadArticles();
          setSelectedArticle(data.article);
        }
      } else {
        throw new Error(collectionType === 'inside' ? "Announcement was not unpublished successfully" : "Article was not unpublished successfully");
      }
    } catch (error: any) {
      console.error("Error unpublishing:", error);
      toast.error(error.message || "Failed to unpublish");
    } finally {
      setUnpublishing(false);
    }
  };

  const handleCoverImageUpload = async (file: File) => {
    if (!session) return;

    setUploadingCover(true);
    try {
      const formData = new FormData();
      formData.append('image', file);

      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/admin/blog/upload-image`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        let error;
        try {
          error = JSON.parse(text);
        } catch (e) {
          console.error('Non-JSON error response:', text);
          throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || "Failed to upload image");
      }

      const text = await response.text();
      const data = JSON.parse(text);
      const { url } = data;
      setFormData(prev => ({ ...prev, cover_image_url: url }));
      toast.success("Cover image uploaded successfully");
    } catch (error: any) {
      console.error("Cover image upload error:", error);
      toast.error(error.message || "Failed to upload cover image");
    } finally {
      setUploadingCover(false);
    }
  };

  const handleVideoUpload = async (file: File) => {
    if (!session) return;

    setUploadingVideo(true);
    try {
      const uploadFormData = new FormData();
      uploadFormData.append('video', file);

      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/admin/resources/upload-video`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: uploadFormData,
      });

      if (!response.ok) {
        const text = await response.text();
        let error;
        try {
          error = JSON.parse(text);
        } catch (e) {
          console.error('Non-JSON error response:', text);
          throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || "Failed to upload video");
      }

      const text = await response.text();
      const data = JSON.parse(text);
      const { url } = data;
      setFormData(prev => ({ ...prev, video_file_url: url }));
      toast.success("Video uploaded successfully");
    } catch (error: any) {
      console.error("Video upload error:", error);
      toast.error(error.message || "Failed to upload video");
    } finally {
      setUploadingVideo(false);
    }
  };

  const getFilteredItems = () => {
    let items: any[] = [];
    if (collectionType === 'blog') {
      items = articles;
    } else if (collectionType === 'tutorials') {
      items = tutorials;
    } else if (collectionType === 'use-cases') {
      items = useCases;
    } else if (collectionType === 'inside') {
      items = insideAnnouncements;
    }

    if (!searchQuery) return items;
    const query = searchQuery.toLowerCase();
    return items.filter((item: any) => {
      return (
        item.title?.toLowerCase().includes(query) ||
        item.slug?.toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query) ||
        item.meta_description?.toLowerCase().includes(query) ||
        item.intro_text?.toLowerCase().includes(query)
      );
    });
  };

  const filteredItems = getFilteredItems();
  const drafts = filteredItems.filter((a: any) => a.status === 'draft');
  const published = filteredItems.filter((a: any) => a.status === 'published');

  const handleDelete = async (item: any) => {
    if (!session) return;

    setDeleting(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      let endpoint = '';

      if (collectionType === 'blog' || collectionType === 'inside') {
        endpoint = `${apiUrl}/api/admin/blog/articles/${item.id}`;
      } else if (collectionType === 'tutorials') {
        endpoint = `${apiUrl}/api/admin/resources/tutorials/${item.id}`;
      } else if (collectionType === 'use-cases') {
        endpoint = `${apiUrl}/api/admin/resources/use-cases/${item.id}`;
      }

      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let error = {};
        try {
          error = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to delete: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || "Failed to delete");
      }

      toast.success("Deleted successfully");
      await loadCurrentCollection();
      setItemToDelete(null);
      setDeleteDialogOpen(false);
    } catch (error: any) {
      console.error("Error deleting:", error);
      toast.error(error.message || "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  // Always show something, even if loading or error
  if (loading) {
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center">
          <div className="text-muted-foreground text-lg mb-2">Loading CMS...</div>
          <div className="text-sm text-muted-foreground">Please wait</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center">
          <div className="text-muted-foreground mb-2 text-lg">No session found</div>
          <div className="text-sm text-muted-foreground">Please log in to access the CMS</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background font-sans" data-testid="admin-cms-container">
      {/* Left Sidebar - Collections */}
      <div className="w-64 border-r border-border/40 bg-background/50 flex flex-col">
        <div className="p-4 pt-6">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-2">Collections</h2>
          <div className="space-y-1">
            <div
              onClick={() => {
                setCollectionType('blog');
                setIsEditing(false);
                setSelectedArticle(null);
                setSelectedTutorial(null);
                setSelectedUseCase(null);
                setSelectedInside(null);
              }}
              className={`flex items-center gap-2 p-2 rounded-md font-medium text-sm cursor-pointer transition-colors ${
                collectionType === 'blog'
                  ? 'bg-accent/50 text-accent-foreground'
                  : 'hover:bg-muted/50 text-muted-foreground'
              }`}
            >
              <FileText className="h-4 w-4 opacity-70" />
              <span>Guides</span>
              <span className="ml-auto text-xs text-muted-foreground font-normal">{articles.length}</span>
            </div>
            <div
              onClick={() => {
                setCollectionType('tutorials');
                setIsEditing(false);
                setSelectedArticle(null);
                setSelectedTutorial(null);
                setSelectedUseCase(null);
                setSelectedInside(null);
              }}
              className={`flex items-center gap-2 p-2 rounded-md font-medium text-sm cursor-pointer transition-colors ${
                collectionType === 'tutorials'
                  ? 'bg-accent/50 text-accent-foreground'
                  : 'hover:bg-muted/50 text-muted-foreground'
              }`}
            >
              <Play className="h-4 w-4 opacity-70" />
              <span>Tutorials</span>
              <span className="ml-auto text-xs text-muted-foreground font-normal">{tutorials.length}</span>
            </div>
            <div
              onClick={() => {
                setCollectionType('use-cases');
                setIsEditing(false);
                setSelectedArticle(null);
                setSelectedTutorial(null);
                setSelectedUseCase(null);
                setSelectedInside(null);
              }}
              className={`flex items-center gap-2 p-2 rounded-md font-medium text-sm cursor-pointer transition-colors ${
                collectionType === 'use-cases'
                  ? 'bg-accent/50 text-accent-foreground'
                  : 'hover:bg-muted/50 text-muted-foreground'
              }`}
            >
              <Briefcase className="h-4 w-4 opacity-70" />
              <span>Use Cases</span>
              <span className="ml-auto text-xs text-muted-foreground font-normal">{useCases.length}</span>
            </div>
            <div
              onClick={() => {
                setCollectionType('inside');
                setIsEditing(false);
                setSelectedArticle(null);
                setSelectedTutorial(null);
                setSelectedUseCase(null);
                setSelectedInside(null);
              }}
              className={`flex items-center gap-2 p-2 rounded-md font-medium text-sm cursor-pointer transition-colors ${
                collectionType === 'inside'
                  ? 'bg-accent/50 text-accent-foreground'
                  : 'hover:bg-muted/50 text-muted-foreground'
              }`}
            >
              <Megaphone className="h-4 w-4 opacity-70" />
              <span>Inside</span>
              <span className="ml-auto text-xs text-muted-foreground font-normal">{insideAnnouncements.length}</span>
            </div>
            <div
              onClick={() => navigate('/admin/resources')}
              className="flex items-center gap-2 p-2 rounded-md font-medium text-sm cursor-pointer transition-colors hover:bg-muted/50 text-muted-foreground"
            >
              <BookOpen className="h-4 w-4 opacity-70" />
              <span>Resources</span>
              <span className="ml-auto text-xs text-muted-foreground font-normal">↗</span>
            </div>
          </div>
        </div>

        <div className="mt-auto p-4 border-t border-border/40">
          <Button variant="outline" size="sm" className="w-full justify-start font-normal text-muted-foreground hover:text-foreground">
            <div className="h-4 w-4 mr-2 rounded-full border border-current flex items-center justify-center text-[10px]">?</div>
            Watch Tutorials
          </Button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col bg-background">
        {/* Top Bar */}
        <div className="h-14 border-b border-border/40 px-6 flex items-center justify-between bg-background/80 backdrop-blur-sm sticky top-0 z-20">
          <div className="flex items-center gap-4">
            {isEditing ? (
              <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" onClick={() => setIsEditing(false)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : (
              <div className="font-semibold text-lg tracking-tight">CMS</div>
            )}
            
            {isEditing && (
              <span className="text-sm font-medium text-muted-foreground">
                / {collectionType === 'blog' ? 'Guides' : collectionType === 'tutorials' ? 'Tutorials' : collectionType === 'inside' ? 'Inside' : 'Use Cases'} / {formData.title || 'Untitled'}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {!isEditing && collectionType !== 'background-inspirations' && (
              <Button 
                className="h-8 rounded-full px-4 text-xs font-medium bg-foreground text-background hover:bg-foreground/90" 
                onClick={handleCreateNew}
              >
                <Plus className="h-3 w-3 mr-1.5" />
                New Item
              </Button>
            )}
            {isEditing && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs font-medium h-8 text-muted-foreground hover:text-foreground"
                  onClick={handleSaveDraft}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Draft"}
                </Button>
                {(collectionType === 'blog' && selectedArticle?.status === 'published') || (collectionType === 'inside' && selectedInside?.status === 'published') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-full px-4 text-xs font-medium border-orange-500 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                    onClick={handleUnpublish}
                    disabled={unpublishing}
                  >
                    {unpublishing ? "Unpublishing..." : "Unpublish"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 rounded-full px-4 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
                    onClick={handlePublish}
                    disabled={publishing}
                  >
                    {publishing ? "Publishing..." : "Publish"}
                  </Button>
                )}
                <div className="w-px h-4 bg-border mx-2" />
              </>
            )}
            <div className="flex items-center text-muted-foreground">
               <Button variant="ghost" size="icon" className="h-8 w-8">
                 <Search className="h-4 w-4" />
               </Button>
            </div>
          </div>
        </div>

        {!isEditing ? (
          /* Content List View */
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-screen-2xl mx-auto">
              {/* Search Bar */}
              <div className="px-6 py-4">
                <div className="relative max-w-md">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={`Search ${collectionType === 'blog' ? 'articles' : collectionType === 'tutorials' ? 'tutorials' : collectionType === 'use-cases' ? 'use cases' : 'inspirations'}...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-9 bg-muted/30 border-transparent focus:bg-background transition-all"
                  />
                </div>
              </div>

              {/* Drafts Section */}
              {drafts.length > 0 && (
                <div className="mb-8">
                  <div className="px-6 py-2 flex items-center">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Drafts</h3>
                    <span className="ml-2 px-1.5 py-0.5 rounded-full bg-muted text-[10px] font-medium text-muted-foreground">{drafts.length}</span>
                  </div>
                  <div className="border-y border-border/40">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-1/3">Title</th>
                          <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Slug</th>
                          <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                          <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                          <th className="text-right px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40 bg-background">
                        {drafts.map((item: any) => (
                          <tr
                            key={item.id}
                            className="group hover:bg-muted/30 cursor-pointer transition-colors"
                            onClick={() => {
                              if (collectionType === 'blog') handleSelectArticle(item);
                              else if (collectionType === 'tutorials') handleSelectTutorial(item);
                              else if (collectionType === 'use-cases') handleSelectUseCase(item);
                              else if (collectionType === 'inside') handleSelectInside(item);
                            }}
                          >
                            <td className="px-6 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded bg-muted/50 flex items-center justify-center text-muted-foreground group-hover:bg-background transition-colors border border-transparent group-hover:border-border/60">
                                  {(collectionType === 'blog' || collectionType === 'inside') && item.cover_image_url ? (
                                    <img src={item.cover_image_url} className="w-full h-full object-cover rounded" alt="" />
                                  ) : collectionType === 'tutorials' ? (
                                    <Play className="h-4 w-4" />
                                  ) : collectionType === 'inside' ? (
                                    <Megaphone className="h-4 w-4" />
                                  ) : (
                                    <Briefcase className="h-4 w-4" />
                                  )}
                                </div>
                                <span className="font-medium text-foreground">{item.title}</span>
                              </div>
                            </td>
                            <td className="px-6 py-3.5 text-muted-foreground font-mono text-xs">{item.slug}</td>
                            <td className="px-6 py-3.5 text-muted-foreground">
                              {format(new Date(item.updated_at), "MMM d, yyyy")}
                            </td>
                            <td className="px-6 py-3.5">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/10 text-yellow-600">
                                Draft
                              </span>
                            </td>
                            <td className="px-6 py-3.5 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (collectionType === 'blog') handleSelectArticle(item);
                                    else if (collectionType === 'tutorials') handleSelectTutorial(item);
                                    else if (collectionType === 'use-cases') handleSelectUseCase(item);
                                    else if (collectionType === 'inside') handleSelectInside(item);
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setItemToDelete(item);
                                    setDeleteDialogOpen(true);
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Published Section */}
              <div>
                <div className="px-6 py-2 flex items-center">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Published</h3>
                  <span className="ml-2 px-1.5 py-0.5 rounded-full bg-muted text-[10px] font-medium text-muted-foreground">{published.length}</span>
                </div>
                <div className="border-y border-border/40 mb-12">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-1/3">Title</th>
                        <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Slug</th>
                        <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Published Date</th>
                        <th className="text-left px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                        <th className="text-right px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40 bg-background">
                      {published.length > 0 ? published.map((item: any) => (
                        <tr
                          key={item.id}
                          className="group hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => {
                            if (collectionType === 'blog') handleSelectArticle(item);
                            else if (collectionType === 'tutorials') handleSelectTutorial(item);
                            else if (collectionType === 'use-cases') handleSelectUseCase(item);
                            else if (collectionType === 'inside') handleSelectInside(item);
                          }}
                        >
                          <td className="px-6 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded bg-muted/50 flex items-center justify-center text-muted-foreground group-hover:bg-background transition-colors border border-transparent group-hover:border-border/60">
                                {(collectionType === 'blog' || collectionType === 'inside') && item.cover_image_url ? (
                                  <img src={item.cover_image_url} className="w-full h-full object-cover rounded" alt="" />
                                ) : collectionType === 'blog' ? (
                                  <FileText className="h-4 w-4" />
                                ) : collectionType === 'tutorials' ? (
                                  <Play className="h-4 w-4" />
                                ) : collectionType === 'inside' ? (
                                  <Megaphone className="h-4 w-4" />
                                ) : (
                                  <Briefcase className="h-4 w-4" />
                                )}
                              </div>
                              <span className="font-medium text-foreground">{item.title}</span>
                              {collectionType === 'blog' && item.featured && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-600 border border-blue-500/20">Featured</span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-3.5 text-muted-foreground font-mono text-xs">{item.slug}</td>
                          <td className="px-6 py-3.5 text-muted-foreground">
                            {item.published_at ? format(new Date(item.published_at), "MMM d, yyyy") : item.created_at ? format(new Date(item.created_at), "MMM d, yyyy") : "-"}
                          </td>
                          <td className="px-6 py-3.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-600">
                              Published
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (collectionType === 'blog') handleSelectArticle(item);
                                  else if (collectionType === 'tutorials') handleSelectTutorial(item);
                                  else if (collectionType === 'use-cases') handleSelectUseCase(item);
                                  else if (collectionType === 'inside') handleSelectInside(item);
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setItemToDelete(item);
                                  setDeleteDialogOpen(true);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                            No published items yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Editor View */
          <div className="flex-1 overflow-y-auto bg-background">
            <div className={`${collectionType === 'blog' ? 'max-w-5xl' : 'max-w-3xl'} mx-auto`}>
              {/* Document Title */}
              <div className="pb-4 pt-8 px-8 space-y-4">
                <Input
                  id="title"
                  placeholder={collectionType === 'blog' ? 'Article Title' : collectionType === 'tutorials' ? 'Tutorial Title' : 'Use Case Title'}
                  value={formData.title}
                  onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                  className="text-4xl font-bold border-none shadow-none p-0 h-auto placeholder:text-muted-foreground/40 focus-visible:ring-0"
                />
                
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="opacity-50">
                    {collectionType === 'blog' ? '/blog/' : collectionType === 'tutorials' ? '/tutorials/' : '/use-cases/'}
                  </span>
                  <Input
                    id="slug"
                    placeholder="url-slug"
                    value={formData.slug}
                    onChange={(e) => {
                      setSlugManuallyEdited(true);
                      setFormData(prev => ({ ...prev, slug: e.target.value }));
                    }}
                    className="h-6 py-0 px-1 w-auto min-w-[100px] border-none shadow-none focus-visible:ring-0 font-mono text-sm text-foreground bg-transparent hover:bg-muted/50 rounded transition-colors"
                  />
                </div>
              </div>

              <div className={`px-8 py-8 space-y-8`}>
                <div className={`grid ${collectionType === 'blog' || collectionType === 'inside' ? 'grid-cols-[8fr_3fr]' : 'grid-cols-[7fr_4fr]'} gap-8 border-t border-border/40 pt-8`}>
                {/* Main Column */}
                <div className="space-y-8">
                  {collectionType === 'blog' ? (
                    <>
                      <div className="space-y-3">
                        <Label htmlFor="meta_description" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Description</Label>
                        <Textarea
                          id="meta_description"
                          placeholder="Short description for SEO and previews..."
                          value={formData.meta_description}
                          onChange={(e) => setFormData(prev => ({ ...prev, meta_description: e.target.value }))}
                          className="min-h-[80px] resize-none bg-muted/20 border-transparent focus:bg-background focus:border-border transition-all"
                        />
                      </div>

                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Content</Label>
                        <div className="min-h-[500px] max-h-[calc(100vh-300px)]">
                          <BlogContentEditor
                            content={formData.content}
                            onChange={(content) => setFormData(prev => ({ ...prev, content }))}
                          />
                        </div>
                      </div>
                    </>
                  ) : collectionType === 'tutorials' ? (
                    <>
                      <div className="space-y-3">
                        <Label htmlFor="description" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Description</Label>
                        <Textarea
                          id="description"
                          placeholder="Short description of the tutorial..."
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          className="min-h-[80px] resize-none bg-muted/20 border-transparent focus:bg-background focus:border-border transition-all"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-3">
                          <Label htmlFor="duration" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Duration</Label>
                          <Input
                            id="duration"
                            placeholder="e.g., 5 min, 12 min"
                            value={formData.duration}
                            onChange={(e) => setFormData(prev => ({ ...prev, duration: e.target.value }))}
                            className="bg-muted/20 border-transparent focus:bg-background focus:border-border"
                          />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="order_index" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Order</Label>
                          <Input
                            id="order_index"
                            type="number"
                            placeholder="0"
                            value={formData.order_index}
                            onChange={(e) => setFormData(prev => ({ ...prev, order_index: parseInt(e.target.value) || 0 }))}
                            className="bg-muted/20 border-transparent focus:bg-background focus:border-border"
                          />
                        </div>
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="video_url" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Video URL (External)</Label>
                        <Input
                          id="video_url"
                          placeholder="https://youtube.com/watch?v=..."
                          value={formData.video_url}
                          onChange={(e) => setFormData(prev => ({ ...prev, video_url: e.target.value }))}
                          className="bg-muted/20 border-transparent focus:bg-background focus:border-border"
                        />
                        <p className="text-xs text-muted-foreground">Or upload a video file below</p>
                      </div>
                    </>
                  ) : collectionType === 'inside' ? (
                    <>
                      <div className="space-y-3">
                        <Label htmlFor="meta_description" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">SEO Description</Label>
                        <Textarea
                          id="meta_description"
                          placeholder="Short description for SEO and previews..."
                          value={formData.meta_description}
                          onChange={(e) => setFormData(prev => ({ ...prev, meta_description: e.target.value }))}
                          className="min-h-[60px] resize-none bg-muted/20 border-transparent focus:bg-background focus:border-border transition-all"
                        />
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="intro_text" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Intro Text</Label>
                        <Textarea
                          id="intro_text"
                          placeholder="Brief introduction that appears before the video..."
                          value={formData.intro_text}
                          onChange={(e) => setFormData(prev => ({ ...prev, intro_text: e.target.value }))}
                          className="min-h-[80px] resize-none bg-muted/20 border-transparent focus:bg-background focus:border-border transition-all"
                        />
                        <p className="text-xs text-muted-foreground">This text appears centered above the video embed</p>
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="video_url" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Video URL</Label>
                        <Input
                          id="video_url"
                          placeholder="https://youtube.com/watch?v=... or Vimeo/Loom/Tella URL"
                          value={formData.video_url}
                          onChange={(e) => setFormData(prev => ({ ...prev, video_url: e.target.value }))}
                          className="bg-muted/20 border-transparent focus:bg-background focus:border-border"
                        />
                        <p className="text-xs text-muted-foreground">Supports YouTube, Vimeo, Loom, and Tella videos</p>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Body Content</Label>
                        <div className="min-h-[400px] max-h-[calc(100vh-300px)]">
                          <BlogContentEditor
                            content={formData.content}
                            onChange={(content) => setFormData(prev => ({ ...prev, content }))}
                          />
                        </div>
                      </div>
                    </>
                  ) : collectionType === 'use-cases' ? (
                    <>
                      <div className="space-y-3">
                        <Label htmlFor="description" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Description</Label>
                        <Textarea
                          id="description"
                          placeholder="Short description..."
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          className="min-h-[80px] resize-none bg-muted/20 border-transparent focus:bg-background focus:border-border transition-all"
                        />
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="order_index" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Order</Label>
                        <Input
                          id="order_index"
                          type="number"
                          placeholder="0"
                          value={formData.order_index}
                          onChange={(e) => setFormData(prev => ({ ...prev, order_index: parseInt(e.target.value) || 0 }))}
                          className="bg-muted/20 border-transparent focus:bg-background focus:border-border"
                        />
                      </div>

                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Content</Label>
                        <div className="min-h-[500px] max-h-[calc(100vh-300px)]">
                          <BlogContentEditor
                            content={formData.content}
                            onChange={(content) => setFormData(prev => ({ ...prev, content }))}
                          />
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>

                {/* Sidebar Column */}
                <div className="space-y-8">
                  {collectionType === 'blog' && (
                    <>
                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Cover Image</Label>
                        <div 
                          className={`
                            relative aspect-video rounded-lg border-2 border-dashed border-border/60 
                            hover:border-primary/50 hover:bg-muted/30 transition-all cursor-pointer
                            flex flex-col items-center justify-center text-center p-4 overflow-hidden
                            ${formData.cover_image_url ? 'border-none' : ''}
                          `}
                          onClick={() => coverImageInputRef.current?.click()}
                        >
                          {formData.cover_image_url ? (
                            <>
                              <img
                                src={formData.cover_image_url}
                                alt="Cover"
                                className="absolute inset-0 w-full h-full object-cover"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-white text-xs font-medium">Change Image</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center mb-2">
                                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {uploadingCover ? "Uploading..." : "Click to upload"}
                              </span>
                            </>
                          )}
                        </div>
                        <input
                          ref={coverImageInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              handleCoverImageUpload(file);
                            }
                          }}
                        />
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="date" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Publish Date</Label>
                        <div className="relative">
                          <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                          <Input
                            id="date"
                            value={formData.date}
                            onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                            className="pl-9 bg-muted/20 border-transparent focus:bg-background focus:border-border h-9 text-sm"
                          />
                        </div>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Settings</Label>
                        <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                          <Label htmlFor="category-select" className="text-sm font-normal cursor-pointer">Category</Label>
                          <select
                            id="category-select"
                            value={formData.category || 'blog'}
                            onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                            className="text-xs bg-background border border-border/60 rounded-md px-2 py-1.5 cursor-pointer focus:outline-none focus:border-border"
                          >
                            {CMS_CATEGORIES.map((c) => (
                              <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                          <Label htmlFor="featured-toggle" className="text-sm font-normal cursor-pointer">Featured Post</Label>
                          <RadioGroup
                            value={formData.featured ? "yes" : "no"}
                            onValueChange={(value) => setFormData(prev => ({ ...prev, featured: value === "yes" }))}
                            className="flex gap-2"
                          >
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="yes" id="featured-yes" className="h-3 w-3" />
                              <Label htmlFor="featured-yes" className="text-xs font-normal text-muted-foreground cursor-pointer">Yes</Label>
                            </div>
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="no" id="featured-no" className="h-3 w-3" />
                              <Label htmlFor="featured-no" className="text-xs font-normal text-muted-foreground cursor-pointer">No</Label>
                            </div>
                          </RadioGroup>
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                          <Label htmlFor="article-type-toggle" className="text-sm font-normal cursor-pointer">Post type</Label>
                          <RadioGroup
                            value={formData.article_type || 'article'}
                            onValueChange={(value) => setFormData(prev => ({ ...prev, article_type: value as 'article' | 'founder' }))}
                            className="flex gap-2"
                          >
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="article" id="type-article" className="h-3 w-3" />
                              <Label htmlFor="type-article" className="text-xs font-normal text-muted-foreground cursor-pointer">Blog</Label>
                            </div>
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="founder" id="type-founder" className="h-3 w-3" />
                              <Label htmlFor="type-founder" className="text-xs font-normal text-muted-foreground cursor-pointer">Founder</Label>
                            </div>
                          </RadioGroup>
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                          <Label htmlFor="is-guide-toggle" className="text-sm font-normal cursor-pointer">Show as Guide</Label>
                          <RadioGroup
                            value={formData.is_guide ? "yes" : "no"}
                            onValueChange={(value) => setFormData(prev => ({ ...prev, is_guide: value === "yes" }))}
                            className="flex gap-2"
                          >
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="yes" id="is-guide-yes" className="h-3 w-3" />
                              <Label htmlFor="is-guide-yes" className="text-xs font-normal text-muted-foreground cursor-pointer">Yes</Label>
                            </div>
                            <div className="flex items-center space-x-1">
                              <RadioGroupItem value="no" id="is-guide-no" className="h-3 w-3" />
                              <Label htmlFor="is-guide-no" className="text-xs font-normal text-muted-foreground cursor-pointer">No</Label>
                            </div>
                          </RadioGroup>
                        </div>
                      </div>

                      <BlogGraphicsPanel
                        articleId={selectedArticle?.id || null}
                      />
                    </>
                  )}

                  {collectionType === 'inside' && (
                    <>
                      <div className="space-y-3">
                        <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Cover Image (Optional)</Label>
                        <div
                          className={`
                            relative aspect-video rounded-lg border-2 border-dashed border-border/60
                            hover:border-primary/50 hover:bg-muted/30 transition-all cursor-pointer
                            flex flex-col items-center justify-center text-center p-4 overflow-hidden
                            ${formData.cover_image_url ? 'border-none' : ''}
                          `}
                          onClick={() => coverImageInputRef.current?.click()}
                        >
                          {formData.cover_image_url ? (
                            <>
                              <img
                                src={formData.cover_image_url}
                                alt="Cover"
                                className="absolute inset-0 w-full h-full object-cover"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-white text-xs font-medium">Change Image</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center mb-2">
                                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {uploadingCover ? "Uploading..." : "Click to upload"}
                              </span>
                            </>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">Used as thumbnail in the list view</p>
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="inside-date" className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Publish Date</Label>
                        <div className="relative">
                          <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                          <Input
                            id="inside-date"
                            value={formData.date}
                            onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                            className="pl-9 bg-muted/20 border-transparent focus:bg-background focus:border-border h-9 text-sm"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {collectionType === 'tutorials' && (
                    <div className="space-y-3">
                      <Label className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Video File</Label>
                      <div 
                        className={`
                          relative aspect-video rounded-lg border-2 border-dashed border-border/60 
                          hover:border-primary/50 hover:bg-muted/30 transition-all cursor-pointer
                          flex flex-col items-center justify-center text-center p-4 overflow-hidden
                          ${formData.video_file_url ? 'border-none' : ''}
                        `}
                        onClick={() => videoInputRef.current?.click()}
                      >
                        {formData.video_file_url ? (
                          <>
                            <div className="w-full h-full flex items-center justify-center bg-muted/50">
                              <Video className="h-12 w-12 text-muted-foreground" />
                            </div>
                            <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
                              <span className="text-white text-xs font-medium">Change Video</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center mb-2">
                              <Video className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {uploadingVideo ? "Uploading..." : "Click to upload video"}
                            </span>
                          </>
                        )}
                      </div>
                      <input
                        ref={videoInputRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            handleVideoUpload(file);
                          }
                        }}
                      />
                      {formData.video_file_url && (
                        <p className="text-xs text-muted-foreground">Video uploaded: {formData.video_file_url.substring(0, 50)}...</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setItemToDelete(null);
          }
        }}
        onConfirm={() => {
          if (itemToDelete) {
            handleDelete(itemToDelete);
          }
        }}
        title={`Delete ${collectionType === 'blog' ? 'Article' : collectionType === 'tutorials' ? 'Tutorial' : 'Use Case'}`}
        itemName={itemToDelete?.title}
      />
    </div>
  );
}

