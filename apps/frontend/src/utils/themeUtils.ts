import { TemplateBlock } from "@/components/template-editor/BlockRenderer";

// Type definitions for theme configuration
export interface TextTypographyConfig {
  font_family: string;
  font_size: number;
  color: string;
  line_spacing: number;
  text_style: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
  };
  capitalization: "none" | "uppercase" | "lowercase" | "title";
  text_align: "left" | "center" | "right" | "justify";
}

export interface HeadingTypographyConfig {
  font_family: string;
  color: string;
  line_spacing: number;
  text_style: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
  };
  capitalization: "none" | "uppercase" | "lowercase" | "title";
  text_align: "left" | "center" | "right" | "justify";
}

export interface HeadingLevelConfig {
  font_size: number;
  color?: string;
  text_style?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
  };
  capitalization?: "none" | "uppercase" | "lowercase" | "title";
}

export interface ThemeTypographyConfig {
  text: TextTypographyConfig;
  headings: {
    general: HeadingTypographyConfig;
    h1: HeadingLevelConfig;
    h2: HeadingLevelConfig;
    h3: HeadingLevelConfig;
    h4: HeadingLevelConfig;
  };
}

export interface ThemeConfig {
  theme_color: string;
  typography: ThemeTypographyConfig;
}

/**
 * Normalizes any line height value to one of: "1" (Single), "1.5", or "2" (Double)
 * Rules:
 * - ≤1.25 → "1" (Single)
 * - 1.26-1.75 → "1.5"
 * - ≥1.76 → "2" (Double)
 */
export function normalizeLineHeight(
  value: string | number | null | undefined
): "1" | "1.5" | "2" {
  if (!value) return "1.5"; // Default

  const num = typeof value === "string" ? parseFloat(value) : value;

  if (isNaN(num)) return "1.5";

  // Round to nearest: Single (1.0), 1.5, or Double (2.0)
  if (num <= 1.25) return "1"; // 0-1.25 → Single
  if (num <= 1.75) return "1.5"; // 1.26-1.75 → 1.5
  return "2"; // 1.76+ → Double
}

/**
 * Generates a font size scale based on theme's base text size
 * Returns array of font sizes suitable for text blocks
 * All sizes are rounded to even numbers (14, 16, 18, etc.)
 */
export function generateFontSizeScale(baseSize: number): number[] {
  const sizes = [
    baseSize - 4, // 12 if base is 16
    baseSize - 2, // 14 if base is 16
    baseSize, // 16 if base is 16
    baseSize + 2, // 18 if base is 16
    baseSize + 4, // 20 if base is 16
    baseSize + 8, // 24 if base is 16
    baseSize + 12, // 28 if base is 16
    baseSize + 16, // 32 if base is 16
    baseSize + 20, // 36 if base is 16
    baseSize + 32, // 48 if base is 16
    baseSize + 36, // 52 if base is 16
    baseSize + 40, // 56 if base is 16
    baseSize + 44, // 60 if base is 16
    baseSize + 48, // 64 if base is 16
    baseSize + 52, // 68 if base is 16
    baseSize + 56, // 72 if base is 16
  ];
  // Round all sizes to even numbers and filter to valid range (10-72px)
  return sizes
    .map(size => Math.round(size / 2) * 2) // Round to nearest even number
    .filter((size) => size >= 10 && size <= 72)
    .filter((size, index, arr) => arr.indexOf(size) === index); // Remove duplicates
}

/**
 * Gets appropriate font sizes for a block type
 * For text blocks: returns theme-based scale
 * For heading blocks: returns theme-defined heading sizes
 */
export function getThemeFontSizes(
  themeConfig: ThemeConfig,
  blockType: "text" | "heading"
): number[] {
  if (blockType === "text") {
    const baseSize = themeConfig.typography.text.font_size;
    return generateFontSizeScale(baseSize);
  } else {
    // Return heading sizes from theme
    return [
      themeConfig.typography.headings.h1.font_size,
      themeConfig.typography.headings.h2.font_size,
      themeConfig.typography.headings.h3.font_size,
      themeConfig.typography.headings.h4.font_size,
    ];
  }
}

/**
 * Updates HTML content with new inline styles, preserving existing structure
 * If HTML already has a root span with styles, updates it; otherwise wraps in a new span
 */
export function updateHtmlWithStyles(
  html: string,
  styles: {
    fontFamily?: string;
    fontSize?: string;
    color?: string;
    lineHeight?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    textAlign?: string;
    textTransform?: string;
  }
): string {
  if (!html) return html;

  // Build style string with all provided styles
  const styleParts: string[] = [];
  if (styles.fontFamily) styleParts.push(`font-family: ${styles.fontFamily}`);
  if (styles.fontSize) styleParts.push(`font-size: ${styles.fontSize}`);
  if (styles.color) styleParts.push(`color: ${styles.color}`);
  if (styles.lineHeight) styleParts.push(`line-height: ${styles.lineHeight}`);
  if (styles.fontWeight) styleParts.push(`font-weight: ${styles.fontWeight}`);
  if (styles.fontStyle) styleParts.push(`font-style: ${styles.fontStyle}`);
  if (styles.textDecoration) styleParts.push(`text-decoration: ${styles.textDecoration}`);
  if (styles.textAlign) styleParts.push(`text-align: ${styles.textAlign}`);
  if (styles.textTransform) styleParts.push(`text-transform: ${styles.textTransform}`);
  
  const styleString = styleParts.join("; ");

  // If HTML doesn't contain any tags, wrap it in a span
  if (!html.includes("<")) {
    return `<span style="${styleString}">${html}</span>`;
  }

  // Parse HTML to properly handle nested elements and update styles
  // Create a temporary div to parse the HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Find the root contenteditable element or first text-containing element
  let targetElement: HTMLElement | null = null;
  
  // If there's a single root element with style, update it
  if (tempDiv.children.length === 1) {
    targetElement = tempDiv.children[0] as HTMLElement;
  } else {
    // If multiple children, wrap everything in a span
    const wrapper = document.createElement('span');
    while (tempDiv.firstChild) {
      wrapper.appendChild(tempDiv.firstChild);
    }
    tempDiv.appendChild(wrapper);
    targetElement = wrapper;
  }

  // CRITICAL: Completely remove ALL existing typography-related styles first
  // This ensures Design Panel changes completely overwrite any existing custom styles
  if (targetElement) {
    // Remove all existing typography styles
    targetElement.style.removeProperty('font-family');
    targetElement.style.removeProperty('font-size');
    targetElement.style.removeProperty('color');
    targetElement.style.removeProperty('line-height');
    targetElement.style.removeProperty('font-weight');
    targetElement.style.removeProperty('font-style');
    targetElement.style.removeProperty('text-decoration');
    targetElement.style.removeProperty('text-align');
    targetElement.style.removeProperty('text-transform');
    
    // Also remove from any nested spans to ensure complete overwrite
    const allSpans = targetElement.querySelectorAll('span');
    allSpans.forEach(span => {
      span.style.removeProperty('font-family');
      span.style.removeProperty('font-size');
      span.style.removeProperty('color');
      span.style.removeProperty('line-height');
      span.style.removeProperty('font-weight');
      span.style.removeProperty('font-style');
      span.style.removeProperty('text-decoration');
      span.style.removeProperty('text-align');
      span.style.removeProperty('text-transform');
    });
    
    // Now apply all new styles (only the ones provided)
    if (styles.fontFamily) targetElement.style.fontFamily = styles.fontFamily;
    if (styles.fontSize) targetElement.style.fontSize = styles.fontSize;
    if (styles.color) targetElement.style.color = styles.color;
    if (styles.lineHeight) targetElement.style.lineHeight = styles.lineHeight;
    if (styles.fontWeight) targetElement.style.fontWeight = styles.fontWeight;
    if (styles.fontStyle) targetElement.style.fontStyle = styles.fontStyle;
    if (styles.textDecoration) targetElement.style.textDecoration = styles.textDecoration;
    if (styles.textAlign) targetElement.style.textAlign = styles.textAlign;
    if (styles.textTransform) targetElement.style.textTransform = styles.textTransform;
  }

  return tempDiv.innerHTML;
}

/**
 * Applies text theme configuration to a text block
 * @param block - The block to apply theme to
 * @param textConfig - The text typography configuration
 * @param options - Optional settings
 * @param options.preserveColor - If true, preserve the block's existing color (for per-page font colors)
 */
export function applyThemeToTextBlock(
  block: TemplateBlock,
  textConfig: TextTypographyConfig,
  options?: { preserveColor?: boolean }
): Partial<TemplateBlock> {
  const normalizedLineHeight = normalizeLineHeight(textConfig.line_spacing);

  // Determine which color to use:
  // - If preserveColor is true, keep the block's existing color
  // - Otherwise, use the theme color
  const colorToUse = options?.preserveColor && block.styling?.color
    ? block.styling.color
    : textConfig.color;

  // Update HTML content with inline styles
  // CRITICAL: Always ensure fontFamily is provided with fallback
  const fontFamilyToUse = textConfig.font_family || block.styling?.fontFamily || "Arial";
  let updatedHtml = block.content?.html || block.content?.text || "";
  updatedHtml = updateHtmlWithStyles(updatedHtml, {
    fontFamily: fontFamilyToUse,
    fontSize: `${textConfig.font_size}px`,
    color: colorToUse,
    lineHeight: normalizedLineHeight,
    fontWeight: textConfig.text_style?.bold ? "bold" : "normal",
    fontStyle: textConfig.text_style?.italic ? "italic" : "normal",
    textDecoration: textConfig.text_style?.underline ? "underline" : "none",
    textAlign: textConfig.text_align,
    textTransform:
      textConfig.capitalization === "uppercase"
        ? "uppercase"
        : textConfig.capitalization === "lowercase"
        ? "lowercase"
        : textConfig.capitalization === "title"
        ? "capitalize"
        : "none",
  });

  return {
    styling: {
      ...block.styling,
      // CRITICAL: Always ensure fontFamily is set with fallback
      // This ensures toolbar can always detect and display font family
      fontFamily: fontFamilyToUse,
      fontSize: `${textConfig.font_size}px`,
      color: colorToUse,
      lineHeight: normalizedLineHeight,
      fontWeight: textConfig.text_style?.bold ? "bold" : "normal",
      fontStyle: textConfig.text_style?.italic ? "italic" : "normal",
      textDecoration: textConfig.text_style?.underline ? "underline" : "none",
      textAlign: textConfig.text_align,
      textTransform:
        textConfig.capitalization === "uppercase"
          ? "uppercase"
          : textConfig.capitalization === "lowercase"
          ? "lowercase"
          : textConfig.capitalization === "title"
          ? "capitalize"
          : "none",
    },
    content: {
      ...block.content,
      html: updatedHtml,
    },
  };
}

/**
 * Applies heading theme configuration to a heading block
 */
export function applyThemeToHeadingBlock(
  block: TemplateBlock,
  headingConfig: HeadingTypographyConfig,
  levelConfig: HeadingLevelConfig,
  level: number
): Partial<TemplateBlock> {
  const normalizedLineHeight = normalizeLineHeight(
    headingConfig.line_spacing
  );

  // Merge level-specific config with general config
  const fontFamily =
    headingConfig.font_family || block.styling?.fontFamily || "Arial";
  const fontSize = levelConfig.font_size || 24;
  const color = levelConfig.color || headingConfig.color || "#000000";
  const textStyle = {
    bold:
      levelConfig.text_style?.bold !== undefined
        ? levelConfig.text_style.bold
        : headingConfig.text_style?.bold || false,
    italic:
      levelConfig.text_style?.italic !== undefined
        ? levelConfig.text_style.italic
        : headingConfig.text_style?.italic || false,
    underline:
      levelConfig.text_style?.underline !== undefined
        ? levelConfig.text_style.underline
        : headingConfig.text_style?.underline || false,
  };
  const capitalization =
    levelConfig.capitalization || headingConfig.capitalization || "none";
  const textAlign = headingConfig.text_align || "left";

  // Update HTML content with inline styles
  let updatedHtml = block.content?.html || block.content?.text || "";
  updatedHtml = updateHtmlWithStyles(updatedHtml, {
    fontFamily,
    fontSize: `${fontSize}px`,
    color,
    lineHeight: normalizedLineHeight,
    fontWeight: textStyle.bold ? "bold" : "normal",
    fontStyle: textStyle.italic ? "italic" : "normal",
    textDecoration: textStyle.underline ? "underline" : "none",
    textAlign,
    textTransform:
      capitalization === "uppercase"
        ? "uppercase"
        : capitalization === "lowercase"
        ? "lowercase"
        : capitalization === "title"
        ? "capitalize"
        : "none",
  });

  return {
    styling: {
      ...block.styling,
      fontFamily,
      fontSize: `${fontSize}px`,
      color,
      lineHeight: normalizedLineHeight,
      fontWeight: textStyle.bold ? "bold" : "normal",
      fontStyle: textStyle.italic ? "italic" : "normal",
      textDecoration: textStyle.underline ? "underline" : "none",
      textAlign,
      textTransform:
        capitalization === "uppercase"
          ? "uppercase"
          : capitalization === "lowercase"
          ? "lowercase"
          : capitalization === "title"
          ? "capitalize"
          : "none",
    },
    content: {
      ...block.content,
      html: updatedHtml,
    },
  };
}

/**
 * Applies a single typography property change to a text block
 * Used when user makes changes in DesignPanel (not applying full theme)
 * CRITICAL: This function COMPLETELY OVERWRITES existing inline styles to ensure
 * Design Panel changes always take precedence over individual block edits
 * 
 * @param designPanelState - Optional object containing ALL current Design Panel state values.
 *                           If provided, these values will be used to completely overwrite block styles.
 *                           When provided, existing styling is reset first, then all properties from state are applied.
 *                           If not provided, only the changed property will be updated (backward compatibility).
 */

/**
 * Apply a color change to all text nodes in a TipTap JSON document.
 * Updates textStyle marks on text nodes inside paragraphs, list items, blockquotes, etc.
 * Headings are NOT changed here — use applyHeadingPropertyToBlock for headings.
 */
function applyColorToTiptapDoc(tiptapDoc: any, color: string): any {
  if (!tiptapDoc || !tiptapDoc.content) return tiptapDoc;

  const doc = JSON.parse(JSON.stringify(tiptapDoc)); // Deep clone

  function updateTextNodes(nodes: any[]) {
    if (!nodes || !Array.isArray(nodes)) return;
    for (const node of nodes) {
      // Apply color to text nodes inside paragraphs (not headings)
      if (node.type === 'paragraph' && node.content) {
        for (const child of node.content) {
          if (child.type === 'text') {
            child.marks = child.marks || [];
            const existing = child.marks.find((m: any) => m.type === 'textStyle');
            if (existing) {
              existing.attrs = existing.attrs || {};
              existing.attrs.color = color;
            } else {
              child.marks.push({ type: 'textStyle', attrs: { color } });
            }
          } else if (child.type === 'variable') {
            child.attrs = child.attrs || {};
            child.attrs.color = color;
          }
        }
      }
      // Recurse into containers (listItem, blockquote, column, columns, etc.)
      if (node.content && node.type !== 'heading') {
        updateTextNodes(node.content);
      }
    }
  }

  updateTextNodes(doc.content);
  return doc;
}

/**
 * Apply a color change to all heading text nodes in a TipTap JSON document.
 */
function applyColorToTiptapHeadings(tiptapDoc: any, color: string): any {
  if (!tiptapDoc || !tiptapDoc.content) return tiptapDoc;

  const doc = JSON.parse(JSON.stringify(tiptapDoc));

  function updateHeadings(nodes: any[]) {
    if (!nodes || !Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === 'heading' && node.content) {
        for (const child of node.content) {
          if (child.type === 'text') {
            child.marks = child.marks || [];
            const existing = child.marks.find((m: any) => m.type === 'textStyle');
            if (existing) {
              existing.attrs = existing.attrs || {};
              existing.attrs.color = color;
            } else {
              child.marks.push({ type: 'textStyle', attrs: { color } });
            }
          } else if (child.type === 'variable') {
            child.attrs = child.attrs || {};
            child.attrs.color = color;
          }
        }
      }
      // Recurse into containers (columns, etc.) but skip paragraphs
      if (node.content && node.type !== 'paragraph') {
        updateHeadings(node.content);
      }
    }
  }

  updateHeadings(doc.content);
  return doc;
}

export function applyTextPropertyToBlock(
  block: TemplateBlock,
  property: "fontFamily" | "fontSize" | "color" | "lineHeight" | "fontWeight" | "fontStyle" | "textDecoration" | "textAlign" | "textTransform",
  value: string,
  designPanelState?: {
    fontFamily?: string;
    fontSize?: string;
    color?: string;
    lineHeight?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    textAlign?: string;
    textTransform?: string;
  }
): Partial<TemplateBlock> {
  const currentHtml = block.content?.html || block.content?.text || "";
  
  // CRITICAL: When applying from Design Panel, we need to completely overwrite existing styles
  // If designPanelState is provided, use those values (they represent the current Design Panel state)
  // Reset existing styling first, then apply all properties from state
  const designPanelStyles: any = designPanelState ? {
    fontFamily: designPanelState.fontFamily,
    fontSize: designPanelState.fontSize,
    color: designPanelState.color,
    lineHeight: designPanelState.lineHeight,
    fontWeight: designPanelState.fontWeight,
    fontStyle: designPanelState.fontStyle,
    textDecoration: designPanelState.textDecoration,
    textAlign: designPanelState.textAlign,
    textTransform: designPanelState.textTransform,
  } : {
    fontFamily: block.styling?.fontFamily || undefined,
    fontSize: block.styling?.fontSize || undefined,
    color: block.styling?.color || undefined,
    lineHeight: block.styling?.lineHeight || undefined,
    fontWeight: block.styling?.fontWeight || undefined,
    fontStyle: block.styling?.fontStyle || undefined,
    textDecoration: block.styling?.textDecoration || undefined,
    textAlign: block.styling?.textAlign || undefined,
    textTransform: block.styling?.textTransform || undefined,
  };
  
  // Override with the new property value (this is the value being changed right now)
  if (property === "fontFamily") designPanelStyles.fontFamily = value;
  if (property === "fontSize") designPanelStyles.fontSize = value.includes("px") ? value : `${value}px`;
  if (property === "color") designPanelStyles.color = value;
  if (property === "lineHeight") designPanelStyles.lineHeight = value;
  if (property === "fontWeight") designPanelStyles.fontWeight = value;
  if (property === "fontStyle") designPanelStyles.fontStyle = value;
  if (property === "textDecoration") designPanelStyles.textDecoration = value;
  if (property === "textAlign") designPanelStyles.textAlign = value;
  if (property === "textTransform") designPanelStyles.textTransform = value;

  // Remove undefined values
  const styles: any = {};
  Object.keys(designPanelStyles).forEach(key => {
    if (designPanelStyles[key] !== undefined) {
      styles[key] = designPanelStyles[key];
    }
  });

  // Update HTML with complete style object - this will overwrite all existing inline styles
  const updatedHtml = updateHtmlWithStyles(currentHtml, styles);

  // When designPanelState is provided, reset styling completely (don't merge with existing)
  // CRITICAL: Always include ALL typography properties to ensure complete overwrite
  // This prevents any old styling properties from persisting
  if (designPanelState) {
    // Reset styling completely - include ALL properties (even if undefined, to clear old values)
    const stylingUpdate: any = {
      fontFamily: styles.fontFamily || null,
      fontSize: styles.fontSize || null,
      color: styles.color || null,
      lineHeight: styles.lineHeight || null,
      fontWeight: styles.fontWeight || null,
      fontStyle: styles.fontStyle || null,
      textDecoration: styles.textDecoration || null,
      textAlign: styles.textAlign || null,
      textTransform: styles.textTransform || null,
    };
    
    // Remove null values to keep styling object clean
    Object.keys(stylingUpdate).forEach(key => {
      if (stylingUpdate[key] === null) {
        delete stylingUpdate[key];
      }
    });
    
    // Also update TipTap JSON content if it exists (the editor renders from tiptap, not html)
    const updatedContent: any = {
      ...block.content,
      html: updatedHtml,
    };
    if (property === 'color' && block.content?.tiptap) {
      updatedContent.tiptap = applyColorToTiptapDoc(block.content.tiptap, value);
    }

    return {
      styling: stylingUpdate, // Complete replacement - no merging
      content: updatedContent,
    };
  }

  // Backward compatibility: merge with existing styling
  const stylingUpdate: any = {};
  if (styles.fontFamily) stylingUpdate.fontFamily = styles.fontFamily;
  if (styles.fontSize) stylingUpdate.fontSize = styles.fontSize;
  if (styles.color) stylingUpdate.color = styles.color;
  if (styles.lineHeight) stylingUpdate.lineHeight = styles.lineHeight;
  if (styles.fontWeight) stylingUpdate.fontWeight = styles.fontWeight;
  if (styles.fontStyle) stylingUpdate.fontStyle = styles.fontStyle;
  if (styles.textDecoration) stylingUpdate.textDecoration = styles.textDecoration;
  if (styles.textAlign) stylingUpdate.textAlign = styles.textAlign;
  if (styles.textTransform) stylingUpdate.textTransform = styles.textTransform;

  const updatedContentLegacy: any = {
    ...block.content,
    html: updatedHtml,
  };
  if (property === 'color' && block.content?.tiptap) {
    updatedContentLegacy.tiptap = applyColorToTiptapDoc(block.content.tiptap, value);
  }

  return {
    styling: {
      ...block.styling,
      ...stylingUpdate,
    },
    content: updatedContentLegacy,
  };
}

/**
 * Applies a single typography property change to a heading block
 * CRITICAL: This function COMPLETELY OVERWRITES existing inline styles to ensure
 * Design Panel changes always take precedence over individual block edits
 *
 * @param fullThemeConfig - Optional object containing complete theme config (headingConfig + levelConfig).
 *                          When provided, ALL theme properties will be applied, resetting existing styling first.
 *                          If not provided, only the changed property will be updated (backward compatibility).
 */
export function applyHeadingPropertyToBlock(
  block: TemplateBlock,
  property: "fontFamily" | "fontSize" | "color" | "lineHeight" | "fontWeight" | "fontStyle" | "textDecoration" | "textAlign" | "textTransform",
  value: string,
  fullThemeConfig?: {
    headingConfig: HeadingTypographyConfig;
    levelConfig: HeadingLevelConfig;
    level: number;
  }
): Partial<TemplateBlock> {
  const currentHtml = block.content?.html || block.content?.text || "";
  
  // If full theme config is provided, apply ALL theme properties (reset existing styling first)
  if (fullThemeConfig) {
    const { headingConfig, levelConfig, level } = fullThemeConfig;
    const normalizedLineHeight = normalizeLineHeight(headingConfig.line_spacing);
    
    // Merge level-specific config with general config
    const fontFamily = headingConfig.font_family || "Arial";
    const fontSize = levelConfig.font_size || 24;
    const color = levelConfig.color || headingConfig.color || "#000000";
    const textStyle = {
      bold: levelConfig.text_style?.bold !== undefined
        ? levelConfig.text_style.bold
        : headingConfig.text_style?.bold || false,
      italic: levelConfig.text_style?.italic !== undefined
        ? levelConfig.text_style.italic
        : headingConfig.text_style?.italic || false,
      underline: levelConfig.text_style?.underline !== undefined
        ? levelConfig.text_style.underline
        : headingConfig.text_style?.underline || false,
    };
    const capitalization = levelConfig.capitalization || headingConfig.capitalization || "none";
    const textAlign = headingConfig.text_align || "left";
    
    // Override with the new property value if provided
    const styles: any = {
      fontFamily,
      fontSize: `${fontSize}px`,
      color,
      lineHeight: normalizedLineHeight,
      fontWeight: textStyle.bold ? "bold" : "normal",
      fontStyle: textStyle.italic ? "italic" : "normal",
      textDecoration: textStyle.underline ? "underline" : "none",
      textAlign,
      textTransform:
        capitalization === "uppercase"
          ? "uppercase"
          : capitalization === "lowercase"
          ? "lowercase"
          : capitalization === "title"
          ? "capitalize"
          : "none",
    };
    
    // Override the specific property being changed
    if (property === "fontFamily") styles.fontFamily = value;
    if (property === "fontSize") styles.fontSize = value.includes("px") ? value : `${value}px`;
    if (property === "color") styles.color = value;
    if (property === "lineHeight") styles.lineHeight = value;
    if (property === "fontWeight") styles.fontWeight = value;
    if (property === "fontStyle") styles.fontStyle = value;
    if (property === "textDecoration") styles.textDecoration = value;
    if (property === "textAlign") styles.textAlign = value;
    if (property === "textTransform") styles.textTransform = value;
    
    // Update HTML with complete style object - this will overwrite all existing inline styles
    const updatedHtml = updateHtmlWithStyles(currentHtml, styles);
    
    // CRITICAL: Return complete styling object - this completely replaces block.styling
    // All typography properties are included to ensure complete overwrite
    return {
      styling: {
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        color: styles.color,
        lineHeight: styles.lineHeight,
        fontWeight: styles.fontWeight,
        fontStyle: styles.fontStyle,
        textDecoration: styles.textDecoration,
        textAlign: styles.textAlign,
        textTransform: styles.textTransform,
      }, // Complete replacement - no merging with existing block.styling
      content: (() => {
        const c: any = { ...block.content, html: updatedHtml };
        if (property === 'color' && block.content?.tiptap) {
          c.tiptap = applyColorToTiptapHeadings(block.content.tiptap, styles.color);
        }
        return c;
      })(),
    };
  }

  // Fallback to original behavior: build complete style object using Design Panel values (from block.styling) merged with the new property
  // This ensures we overwrite any individual block edits
  const designPanelStyles: any = {
    fontFamily: block.styling?.fontFamily || undefined,
    fontSize: block.styling?.fontSize || undefined,
    color: block.styling?.color || undefined,
    lineHeight: block.styling?.lineHeight || undefined,
    fontWeight: block.styling?.fontWeight || undefined,
    fontStyle: block.styling?.fontStyle || undefined,
    textDecoration: block.styling?.textDecoration || undefined,
    textAlign: block.styling?.textAlign || undefined,
    textTransform: block.styling?.textTransform || undefined,
  };
  
  // Override with the new property value
  if (property === "fontFamily") designPanelStyles.fontFamily = value;
  if (property === "fontSize") designPanelStyles.fontSize = value.includes("px") ? value : `${value}px`;
  if (property === "color") designPanelStyles.color = value;
  if (property === "lineHeight") designPanelStyles.lineHeight = value;
  if (property === "fontWeight") designPanelStyles.fontWeight = value;
  if (property === "fontStyle") designPanelStyles.fontStyle = value;
  if (property === "textDecoration") designPanelStyles.textDecoration = value;
  if (property === "textAlign") designPanelStyles.textAlign = value;
  if (property === "textTransform") designPanelStyles.textTransform = value;

  // Remove undefined values
  const styles: any = {};
  Object.keys(designPanelStyles).forEach(key => {
    if (designPanelStyles[key] !== undefined) {
      styles[key] = designPanelStyles[key];
    }
  });

  // Update HTML with complete style object - this will overwrite all existing inline styles
  const updatedHtml = updateHtmlWithStyles(currentHtml, styles);

  // Update styling object with complete values
  const stylingUpdate: any = {};
  if (styles.fontFamily) stylingUpdate.fontFamily = styles.fontFamily;
  if (styles.fontSize) stylingUpdate.fontSize = styles.fontSize;
  if (styles.color) stylingUpdate.color = styles.color;
  if (styles.lineHeight) stylingUpdate.lineHeight = styles.lineHeight;
  if (styles.fontWeight) stylingUpdate.fontWeight = styles.fontWeight;
  if (styles.fontStyle) stylingUpdate.fontStyle = styles.fontStyle;
  if (styles.textDecoration) stylingUpdate.textDecoration = styles.textDecoration;
  if (styles.textAlign) stylingUpdate.textAlign = styles.textAlign;
  if (styles.textTransform) stylingUpdate.textTransform = styles.textTransform;

  const updatedHeadingContent: any = {
    ...block.content,
    html: updatedHtml,
  };
  if (property === 'color' && block.content?.tiptap) {
    updatedHeadingContent.tiptap = applyColorToTiptapHeadings(block.content.tiptap, value);
  }

  return {
    styling: {
      ...block.styling,
      ...stylingUpdate,
    },
    content: updatedHeadingContent,
  };
}

/**
 * Compares two theme configs to detect if theme has been modified
 */
export function isThemeModified(
  original: ThemeConfig | null,
  current: ThemeConfig
): boolean {
  if (!original) return true;

  // Deep comparison of theme configs
  return JSON.stringify(original) !== JSON.stringify(current);
}

/**
 * Builds a complete theme state object for a block from theme config and Design Panel state
 * Used to ensure conversions always have complete theme data
 */
export function buildFullThemeStateForBlock(
  block: TemplateBlock,
  themeConfig: ThemeConfig | null,
  blockType: "text" | "heading",
  level?: number
): {
  fontFamily: string;
  fontSize: string;
  color: string;
  lineHeight: string;
  fontWeight: string;
  fontStyle: string;
  textDecoration: string;
  textAlign: string;
  textTransform: string;
} {
  if (blockType === "text" && themeConfig?.typography?.text) {
    const textConfig = themeConfig.typography.text;
    const normalizedLineHeight = normalizeLineHeight(textConfig.line_spacing);
    
    return {
      fontFamily: textConfig.font_family || "Arial",
      fontSize: `${textConfig.font_size}px`,
      color: textConfig.color || "#000000",
      lineHeight: normalizedLineHeight,
      fontWeight: textConfig.text_style?.bold ? "bold" : "normal",
      fontStyle: textConfig.text_style?.italic ? "italic" : "normal",
      textDecoration: textConfig.text_style?.underline ? "underline" : "none",
      textAlign: textConfig.text_align || "left",
      textTransform:
        textConfig.capitalization === "uppercase"
          ? "uppercase"
          : textConfig.capitalization === "lowercase"
          ? "lowercase"
          : textConfig.capitalization === "title"
          ? "capitalize"
          : "none",
    };
  }
  
  if (blockType === "heading" && themeConfig?.typography?.headings && level) {
    const headingConfig = themeConfig.typography.headings.general;
    const levelConfig = themeConfig.typography.headings[`h${level}` as 'h1' | 'h2' | 'h3' | 'h4'] || {};
    const normalizedLineHeight = normalizeLineHeight(headingConfig.line_spacing);
    
    const fontFamily = headingConfig.font_family || "Arial";
    const fontSize = levelConfig.font_size || 24;
    const color = levelConfig.color || headingConfig.color || "#000000";
    const textStyle = {
      bold: levelConfig.text_style?.bold !== undefined
        ? levelConfig.text_style.bold
        : headingConfig.text_style?.bold || false,
      italic: levelConfig.text_style?.italic !== undefined
        ? levelConfig.text_style.italic
        : headingConfig.text_style?.italic || false,
      underline: levelConfig.text_style?.underline !== undefined
        ? levelConfig.text_style.underline
        : headingConfig.text_style?.underline || false,
    };
    const capitalization = levelConfig.capitalization || headingConfig.capitalization || "none";
    const textAlign = headingConfig.text_align || "left";
    
    return {
      fontFamily,
      fontSize: `${fontSize}px`,
      color,
      lineHeight: normalizedLineHeight,
      fontWeight: textStyle.bold ? "bold" : "normal",
      fontStyle: textStyle.italic ? "italic" : "normal",
      textDecoration: textStyle.underline ? "underline" : "none",
      textAlign,
      textTransform:
        capitalization === "uppercase"
          ? "uppercase"
          : capitalization === "lowercase"
          ? "lowercase"
          : capitalization === "title"
          ? "capitalize"
          : "none",
    };
  }
  
  // Fallback defaults
  const defaultSizes: Record<number, number> = { 1: 36, 2: 28, 3: 22, 4: 18 };
  const defaultSize = level ? (defaultSizes[level] || 24) : 16;
  
  return {
    fontFamily: "Arial",
    fontSize: `${defaultSize}px`,
    color: "#000000",
    lineHeight: "1.5",
    fontWeight: blockType === "heading" ? "bold" : "normal",
    fontStyle: "normal",
    textDecoration: "none",
    textAlign: "left",
    textTransform: "none",
  };
}

/**
 * Gets default theme config with reasonable defaults for fallback scenarios
 */
export function getDefaultThemeConfig(): {
  text: TextTypographyConfig;
  headings: {
    general: HeadingTypographyConfig;
    h1: HeadingLevelConfig;
    h2: HeadingLevelConfig;
    h3: HeadingLevelConfig;
    h4: HeadingLevelConfig;
  };
} {
  return {
    text: {
      font_family: "Arial",
      font_size: 16,
      color: "#000000",
      line_spacing: 1.5,
      text_style: {
        bold: false,
        italic: false,
        underline: false,
      },
      capitalization: "none",
      text_align: "left",
    },
    headings: {
      general: {
        font_family: "Arial",
        color: "#000000",
        line_spacing: 1.5,
        text_style: {
          bold: true,
          italic: false,
          underline: false,
        },
        capitalization: "none",
        text_align: "left",
      },
      h1: {
        font_size: 36,
      },
      h2: {
        font_size: 28,
      },
      h3: {
        font_size: 22,
      },
      h4: {
        font_size: 18,
      },
    },
  };
}
