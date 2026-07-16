import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface CalloutOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /**
       * Insert a callout
       */
      setCallout: (options?: { title?: string; items?: string[] }) => ReturnType;
    };
  }
}

const CalloutComponent = ({ node, updateAttributes }: any) => {
  const { title, items } = node.attrs;
  
  // Ensure we always have at least one item
  const displayItems = items && items.length > 0 ? items : [''];

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateAttributes({ title: e.target.value });
  };

  const handleItemChange = (index: number, value: string) => {
    const newItems = [...displayItems];
    newItems[index] = value;
    updateAttributes({ items: newItems });
  };

  const handleAddItem = () => {
    const newItems = [...displayItems, ''];
    updateAttributes({ items: newItems });
  };

  const handleRemoveItem = (index: number) => {
    const newItems = [...displayItems];
    newItems.splice(index, 1);
    // Ensure at least one item remains
    if (newItems.length === 0) {
      newItems.push('');
    }
    updateAttributes({ items: newItems });
  };

  return (
    <NodeViewWrapper className="callout-wrapper my-6">
      <div className="bg-primary/5 border-l-4 border-primary rounded-r-lg p-6 space-y-4">
        <div>
          <Label htmlFor={`callout-title-${node.attrs.id}`} className="text-xs font-semibold text-primary uppercase tracking-wide mb-2 block">
            Callout Title
          </Label>
          <Input
            id={`callout-title-${node.attrs.id}`}
            value={title || ''}
            onChange={handleTitleChange}
            placeholder="Key Takeaways"
            className="font-semibold text-base bg-background"
          />
        </div>
        
        <div>
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 block">
            Bullet Points
          </Label>
          <div className="space-y-2">
            {(items || []).map((item: string, index: number) => (
              <div key={index} className="flex items-start gap-2">
                <span className="text-primary mt-1.5">•</span>
                <Input
                  value={item}
                  onChange={(e) => handleItemChange(index, e.target.value)}
                  placeholder={`Bullet point ${index + 1}`}
                  className="bg-background flex-1"
                />
                {displayItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveItem(index)}
                    className="text-muted-foreground hover:text-destructive text-sm px-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={handleAddItem}
              className="text-sm text-primary hover:text-primary/80 font-medium mt-2"
            >
              + Add bullet point
            </button>
          </div>
        </div>
      </div>
    </NodeViewWrapper>
  );
};

export const Callout = Node.create<CalloutOptions>({
  name: 'callout',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  content: '',

  addAttributes() {
    return {
      title: {
        default: 'Key Takeaways',
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes) => {
          if (!attributes.title) {
            return {};
          }
          return {
            'data-title': attributes.title,
          };
        },
      },
      items: {
        default: [''],
        parseHTML: (element) => {
          const itemsAttr = element.getAttribute('data-items');
          return itemsAttr ? JSON.parse(itemsAttr) : [''];
        },
        renderHTML: (attributes) => {
          if (!attributes.items || !Array.isArray(attributes.items)) {
            return {};
          }
          return {
            'data-items': JSON.stringify(attributes.items),
          };
        },
      },
      id: {
        default: Math.random().toString(36).substring(7),
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) {
            return {};
          }
          return {
            'data-id': attributes.id,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'callout',
        'data-title': node.attrs.title || 'Key Takeaways',
        'data-items': JSON.stringify(node.attrs.items || ['']),
        'data-id': node.attrs.id || Math.random().toString(36).substring(7),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutComponent);
  },

  addCommands() {
    return {
      setCallout:
        (options = {}) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              title: options.title || 'Key Takeaways',
              items: options.items || [''],
              id: Math.random().toString(36).substring(7),
            },
          });
        },
    };
  },
});
