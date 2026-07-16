/**
 * Clipboard Utilities for Styling Preservation
 * 
 * Stores block styling when text is copied, so it can be applied
 * when pasting into new or existing blocks.
 */

interface ClipboardStyling {
  block_type: string;
  styling: Record<string, any>;
  content?: {
    level?: number; // For headings
  };
  html?: string; // HTML content with inline formatting (bold, italic, underline, etc.)
  text?: string; // Plain text version
}

// Global clipboard store for styling
const getClipboardStore = () => {
  if (!(window as any).__clipboardStyling) {
    (window as any).__clipboardStyling = null;
  }
  return (window as any).__clipboardStyling;
};

/**
 * Store styling when text is copied
 */
export function storeClipboardStyling(styling: ClipboardStyling | null) {
  (window as any).__clipboardStyling = styling;
}

/**
 * Get stored styling from clipboard
 */
export function getClipboardStyling(): ClipboardStyling | null {
  return getClipboardStore();
}

/**
 * Clear stored styling
 */
export function clearClipboardStyling() {
  (window as any).__clipboardStyling = null;
}

