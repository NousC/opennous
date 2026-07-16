/**
 * Template-related TypeScript type definitions
 */

/**
 * Background settings for a single page
 */
export interface PageBackgroundSettings {
  background_image: string | null;
  background_color: string | null;
  background_image_opacity: number;
  background_source?: 'magic_ai' | 'upload' | 'color'; // Track source of background (optional for backward compatibility)
  theme_type?: 'dark' | 'light'; // Track if background is dark or light for font color selection (optional for backward compatibility)
}

/**
 * Map of page index (as string) to background settings
 * Uses string keys for JSONB compatibility (JSONB keys are always strings)
 */
export type PageBackgroundsMap = {
  [pageIndex: string]: PageBackgroundSettings;
};

/**
 * Page index type (number internally, but converted to string for JSONB)
 */
export type PageIndex = number;

/**
 * Footer settings for a single page
 */
export interface PageFooterSettings {
  enabled: boolean;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
}

/**
 * Layout settings for a single page (footer and page numbers)
 */
export interface PageLayoutSettings {
  footer: PageFooterSettings;
  showPageNumbers: boolean;
  pageNumberFontFamily: string;
  pageNumberFontSize: number;
  pageNumberColor: string;
  // Show logo in footer (bottom-right corner)
  showLogo?: boolean;
  // Optional per-page margins in pixels
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
}

/**
 * Map of page index (as string) to layout settings
 * Uses string keys for JSONB compatibility (JSONB keys are always strings)
 */
export type PageLayoutsMap = {
  [pageIndex: string]: PageLayoutSettings;
};

