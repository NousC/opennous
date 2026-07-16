import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

export interface FAQOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    faq: {
      /**
       * Insert an FAQ section
       */
      setFAQ: (options?: { items?: Array<{ question: string; answer: string }> }) => ReturnType;
    };
  }
}

const FAQComponent = ({ node, updateAttributes }: any) => {
  const { items } = node.attrs;
  
  // Ensure we always have at least one FAQ item
  const displayItems = items && items.length > 0 ? items : [{ question: '', answer: '' }];

  const handleQuestionChange = (index: number, value: string) => {
    const newItems = [...displayItems];
    newItems[index] = { ...newItems[index], question: value };
    updateAttributes({ items: newItems });
  };

  const handleAnswerChange = (index: number, value: string) => {
    const newItems = [...displayItems];
    newItems[index] = { ...newItems[index], answer: value };
    updateAttributes({ items: newItems });
  };

  const handleAddItem = () => {
    const newItems = [...displayItems, { question: '', answer: '' }];
    updateAttributes({ items: newItems });
  };

  const handleRemoveItem = (index: number) => {
    const newItems = [...displayItems];
    newItems.splice(index, 1);
    // Ensure at least one item remains
    if (newItems.length === 0) {
      newItems.push({ question: '', answer: '' });
    }
    updateAttributes({ items: newItems });
  };

  return (
    <NodeViewWrapper className="faq-wrapper my-6">
      <div className="bg-primary/5 border-l-4 border-primary rounded-r-lg p-6 space-y-6">
        <div>
          <Label className="text-xs font-semibold text-primary uppercase tracking-wide mb-4 block">
            FAQ Section
          </Label>
        </div>
        
        <div className="space-y-6">
          {displayItems.map((item: { question: string; answer: string }, index: number) => (
            <div key={index} className="bg-background rounded-lg p-4 border border-border/50 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Question {index + 1}
                </Label>
                {displayItems.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveItem(index)}
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <Input
                value={item.question || ''}
                onChange={(e) => handleQuestionChange(index, e.target.value)}
                placeholder="Enter your question here..."
                className="bg-background font-medium"
              />
              
              <div className="mt-3">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 block">
                  Answer
                </Label>
                <Textarea
                  value={item.answer || ''}
                  onChange={(e) => handleAnswerChange(index, e.target.value)}
                  placeholder="Enter the answer here..."
                  className="bg-background min-h-[80px] resize-y"
                  rows={3}
                />
              </div>
            </div>
          ))}
          
          <Button
            type="button"
            variant="outline"
            onClick={handleAddItem}
            className="w-full text-sm text-primary hover:text-primary/80 border-primary/20 hover:border-primary/40"
          >
            + Add FAQ Item
          </Button>
        </div>
      </div>
    </NodeViewWrapper>
  );
};

export const FAQ = Node.create<FAQOptions>({
  name: 'faq',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  content: '',

  addAttributes() {
    return {
      items: {
        default: [{ question: '', answer: '' }],
        parseHTML: (element) => {
          const itemsAttr = element.getAttribute('data-items');
          return itemsAttr ? JSON.parse(itemsAttr) : [{ question: '', answer: '' }];
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
        tag: 'div[data-type="faq"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'faq',
        'data-items': JSON.stringify(node.attrs.items || [{ question: '', answer: '' }]),
        'data-id': node.attrs.id || Math.random().toString(36).substring(7),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FAQComponent);
  },

  addCommands() {
    return {
      setFAQ:
        (options = {}) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              items: options.items || [{ question: '', answer: '' }],
              id: Math.random().toString(36).substring(7),
            },
          });
        },
    };
  },
});
