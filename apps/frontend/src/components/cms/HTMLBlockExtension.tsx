import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';

export interface HTMLBlockOptions {
  HTMLAttributes: Record<string, any>;
}

const HTMLBlockComponent = ({ node }: any) => {
  const { html } = node.attrs;

  if (!html) {
    return null;
  }

  return (
    <NodeViewWrapper className="html-block my-8 not-prose">
      <div
        className="html-block-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </NodeViewWrapper>
  );
};

export const HTMLBlock = Node.create<HTMLBlockOptions>({
  name: 'htmlBlock',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  content: '',

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-html'),
        renderHTML: (attributes) => {
          if (!attributes.html) {
            return {};
          }
          return {
            'data-html': attributes.html,
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
        tag: 'div[data-type="html-block"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'html-block',
        'data-html': node.attrs.html || '',
        'data-id': node.attrs.id || Math.random().toString(36).substring(7),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(HTMLBlockComponent);
  },
});

// Renderer version for ArticleDetail (read-only)
export const HTMLBlockRenderer = Node.create<HTMLBlockOptions>({
  name: 'htmlBlock',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  content: '',

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-html'),
        renderHTML: (attributes) => {
          if (!attributes.html) {
            return {};
          }
          return {
            'data-html': attributes.html,
          };
        },
      },
      id: {
        default: null,
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
        tag: 'div[data-type="html-block"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'html-block',
        'data-html': node.attrs.html || '',
        'data-id': node.attrs.id || '',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(HTMLBlockComponent);
  },
});
