import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';

export interface CTAOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    cta: {
      /**
       * Insert a CTA section
       */
      setCTA: () => ReturnType;
    };
  }
}

const CTAComponent = ({ node }: any) => {
  // This is a read-only component in the editor - it's automatically inserted
  return (
    <NodeViewWrapper className="cta-wrapper my-6">
      <div className="bg-primary/5 border-l-4 border-primary rounded-r-lg p-6">
        <div className="text-sm text-muted-foreground italic">
          CTA Section (automatically inserted before FAQ)
        </div>
      </div>
    </NodeViewWrapper>
  );
};

export const CTA = Node.create<CTAOptions>({
  name: 'cta',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  content: '',

  addAttributes() {
    return {
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
        tag: 'div[data-type="cta"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'cta',
        'data-id': node.attrs.id || Math.random().toString(36).substring(7),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CTAComponent);
  },

  addCommands() {
    return {
      setCTA:
        () =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              id: Math.random().toString(36).substring(7),
            },
          });
        },
    };
  },
});
