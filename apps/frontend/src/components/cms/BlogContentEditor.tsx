import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';
import Blockquote from '@tiptap/extension-blockquote';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Callout } from './CalloutExtension';
import { FAQ } from './FAQExtension';
import { CTA } from './CTAExtension';
import { HTMLBlock } from './HTMLBlockExtension';
import { Button } from '@/components/ui/button';
import {
  Bold,
  Italic,
  Link as LinkIcon,
  Quote,
  Code,
  List,
  ListOrdered,
  Image as ImageIcon,
  Heading1,
  Heading2,
  Heading3,
  Paragraph,
  MessageSquare,
  HelpCircle,
  Table as TableIcon,
  Plus,
  Minus,
  Trash2
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/components/ui/sonner';

interface BlogContentEditorProps {
  content: any;
  onChange: (content: any) => void;
}

export function BlogContentEditor({ content, onChange }: BlogContentEditorProps) {
  const { session } = useAuth();
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-blue-600 underline',
        },
      }),
      Image.configure({
        HTMLAttributes: {
          class: 'max-w-full h-auto rounded',
          loading: 'lazy',
        },
      }),
      CodeBlock,
      Blockquote,
      Table.configure({
        resizable: true,
        HTMLAttributes: {
          class: 'border-collapse border border-border w-full my-4',
        },
      }),
      TableRow,
      TableHeader.configure({
        HTMLAttributes: {
          class: 'border border-border bg-muted/50 px-4 py-2 text-left font-semibold',
        },
      }),
      TableCell.configure({
        HTMLAttributes: {
          class: 'border border-border px-4 py-2',
        },
      }),
      Callout,
      FAQ,
      CTA,
      HTMLBlock,
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-lg max-w-none focus:outline-none min-h-[450px] p-6 prose-headings:font-bold prose-headings:text-foreground prose-h1:text-3xl prose-h1:mt-8 prose-h1:mb-4 prose-h2:text-2xl prose-h2:mt-6 prose-h2:mb-3 prose-h3:text-xl prose-h3:mt-4 prose-h3:mb-2 prose-p:mb-6 prose-p:mt-0',
      },
      handleDrop: (view, event, slice, moved) => {
        // Handle blog graphic drops
        const graphicData = event.dataTransfer?.getData('application/x-blog-graphic');
        if (graphicData && !moved) {
          try {
            const graphic = JSON.parse(graphicData);
            const { schema } = view.state;
            const imageType = schema.nodes.image;
            if (imageType) {
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (pos) {
                const node = imageType.create({
                  src: graphic.image_url || graphic.url,
                  alt: graphic.title || graphic.alt || 'Graphic',
                });
                const transaction = view.state.tr.insert(pos.pos, node);
                view.dispatch(transaction);
                return true;
              }
            }
          } catch (err) {
            console.error('Failed to handle graphic drop:', err);
          }
        }
        return false;
      },
    },
    immediatelyRender: false,
  });

  const handleImageUpload = async (file: File) => {
    if (!session) {
      toast.error('You must be logged in to upload images');
      return;
    }

    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('image', file);

      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const response = await fetch(`${apiUrl}/api/admin/blog/upload-image`, {
        method: 'POST',
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
          // If response is not JSON (might be HTML error page)
          console.error('Non-JSON error response:', text);
          throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
        }
        throw new Error(error.detail || error.message || 'Failed to upload image');
      }

      const text = await response.text();
      const data = JSON.parse(text);
      const { url } = data;

      // Prompt for alt text (important for SEO)
      const altText = window.prompt('Enter alt text for this image (important for SEO):', file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '));

      // Wait for editor to be ready before inserting image
      const insertImage = () => {
        if (!editor) {
          toast.error('Editor not available');
          return;
        }

        // Check if editor view is available
        const tryInsert = () => {
          if (!editor) return;

          try {
            // Try to use chain with focus first
            if (editor.view && editor.view.hasFocus) {
              editor.chain().focus().setImage({ src: url, alt: altText || '' }).run();
            } else {
              // Fallback: use commands directly without focus
              editor.commands.setImage({ src: url, alt: altText || '' });
            }
          } catch (err) {
            // If chain fails, try commands directly
            try {
              editor.commands.setImage({ src: url, alt: altText || '' });
            } catch (cmdErr) {
              console.error('Failed to insert image:', cmdErr);
              toast.error('Failed to insert image into editor');
            }
          }
        };

        // Check if view is available
        if (!editor.view) {
          // Wait for editor to be mounted
          const checkInterval = setInterval(() => {
            if (editor && editor.view) {
              clearInterval(checkInterval);
              tryInsert();
            }
          }, 100);
          
          // Timeout after 2 seconds
          setTimeout(() => {
            clearInterval(checkInterval);
            if (editor) {
              // Try anyway even if view isn't ready
              tryInsert();
            }
          }, 2000);
        } else {
          tryInsert();
        }
      };

      insertImage();
      toast.success('Image uploaded successfully');
    } catch (error: any) {
      console.error('Image upload error:', error);
      toast.error(error.message || 'Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const setLink = () => {
    if (!editor) return;

    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);

    if (url === null) {
      return;
    }

    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  if (!editor) {
    return null;
  }

  // Handle drag and drop for graphics
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-blog-graphic")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    const graphicData = e.dataTransfer.getData("application/x-blog-graphic");
    if (graphicData && editor) {
      try {
        const graphic = JSON.parse(graphicData);
        editor.chain().focus().setImage({ 
          src: graphic.image_url || graphic.url,
          alt: graphic.title || graphic.alt || "Graphic"
        }).run();
      } catch (err) {
        console.error("Failed to parse graphic data:", err);
        // Fallback: try to use as URL
        const url = e.dataTransfer.getData("text/plain");
        if (url && editor) {
          editor.chain().focus().setImage({ src: url, alt: "Graphic" }).run();
        }
      }
    }
  };

  return (
    <div 
      className="relative border border-border/40 rounded-lg bg-background focus-within:ring-1 focus-within:ring-ring/20 transition-all flex flex-col h-full max-h-full"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Toolbar - Sticky & Improved Design */}
      <div className="sticky top-0 z-20 border-b border-border/40 bg-background/98 backdrop-blur-lg shadow-sm px-3 py-2.5 flex items-center gap-2 flex-wrap min-h-[48px] flex-shrink-0">
        <select
          className="h-8 px-3 pr-7 text-xs font-semibold bg-background hover:bg-muted/60 rounded-md border border-border/50 focus:ring-2 focus:ring-ring/50 focus:outline-none cursor-pointer transition-all text-foreground appearance-none shadow-sm hover:shadow"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23999' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 0.5rem center',
          }}
          onChange={(e) => {
            const value = e.target.value;
            if (!editor) return;
            
            // Focus editor first, then apply the heading/paragraph change
            editor.chain().focus().run();
            
            // Small delay to ensure focus is set before applying command
            setTimeout(() => {
              if (value === 'paragraph') {
                editor.chain().focus().setParagraph().run();
              } else if (value.startsWith('heading')) {
                const level = parseInt(value.replace('heading', '')) as 1 | 2 | 3;
                // Set heading - this converts the current block/node to a heading
                editor.chain().focus().setHeading({ level }).run();
              }
            }, 50);
          }}
          onBlur={() => {
            // Refocus editor when dropdown closes
            if (editor) {
              setTimeout(() => {
                editor.chain().focus().run();
              }, 100);
            }
          }}
          value={
            editor.isActive('heading', { level: 1 })
              ? 'heading1'
              : editor.isActive('heading', { level: 2 })
              ? 'heading2'
              : editor.isActive('heading', { level: 3 })
              ? 'heading3'
              : 'paragraph'
          }
        >
          <option value="paragraph">Paragraph</option>
          <option value="heading1">Heading 1</option>
          <option value="heading2">Heading 2</option>
          <option value="heading3">Heading 3</option>
        </select>

        <div className="h-5 w-px bg-border/60 mx-0.5" />

        <div className="flex items-center gap-1 bg-muted/30 rounded-md p-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={setLink}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('link') ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
            title="Link"
          >
            <LinkIcon className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('bold') ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
            title="Bold"
          >
            <Bold className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('italic') ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
            title="Italic"
          >
            <Italic className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('blockquote') ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
            title="Quote"
          >
            <Quote className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('codeBlock') ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'}`}
            title="Code Block"
          >
            <Code className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-5 w-px bg-border/60 mx-0.5" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('bulletList') ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Bullet List"
          >
            <List className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('orderedList') ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Numbered List"
          >
            <ListOrdered className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-5 w-px bg-border/60 mx-0.5" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().setCallout().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('callout') ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Insert Callout"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().setFAQ().run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('faq') ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Insert FAQ"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-5 w-px bg-border/60 mx-0.5" />

        {/* Table Controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            className={`h-7 w-7 p-0 rounded ${editor.isActive('table') ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            title="Insert Table"
          >
            <TableIcon className="h-4 w-4" />
          </Button>

          {editor.isActive('table') && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                className="h-7 px-1.5 rounded text-muted-foreground hover:text-foreground text-xs"
                title="Add Column"
              >
                +Col
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addRowAfter().run()}
                className="h-7 px-1.5 rounded text-muted-foreground hover:text-foreground text-xs"
                title="Add Row"
              >
                +Row
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteColumn().run()}
                className="h-7 px-1.5 rounded text-muted-foreground hover:text-foreground text-xs"
                title="Delete Column"
              >
                -Col
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteRow().run()}
                className="h-7 px-1.5 rounded text-muted-foreground hover:text-foreground text-xs"
                title="Delete Row"
              >
                -Row
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteTable().run()}
                className="h-7 w-7 p-0 rounded text-red-500 hover:text-red-600 hover:bg-red-50"
                title="Delete Table"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>

        <div className="h-5 w-px bg-border/60 mx-0.5" />

        <Button
          variant="ghost"
          size="sm"
          onClick={handleImageClick}
          disabled={uploadingImage}
          className="h-7 w-7 p-0 rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Insert Image"
        >
          <ImageIcon className="h-4 w-4" />
        </Button>

        {/* Edit Alt Text button - shows when image is selected */}
        {editor.isActive('image') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const currentAlt = editor.getAttributes('image').alt || '';
              const newAlt = window.prompt('Edit alt text (important for SEO):', currentAlt);
              if (newAlt !== null) {
                editor.chain().focus().updateAttributes('image', { alt: newAlt }).run();
                toast.success('Alt text updated');
              }
            }}
            className="h-7 px-2 rounded text-muted-foreground hover:text-foreground text-xs"
            title="Edit Alt Text"
          >
            Edit Alt
          </Button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              handleImageUpload(file);
            }
          }}
        />
      </div>

      {/* Editor Content - Scrollable */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

