import { TemplateBlock } from "@/components/template-editor/BlockRenderer";

/**
 * Split blocks into pages based on page_break blocks
 * This is the SINGLE SOURCE OF TRUTH for page splitting logic
 * All components must use this function to ensure consistency
 * 
 * @param blocks - Array of template blocks
 * @returns Array of pages, where each page is an array of blocks
 */
export function splitBlocksIntoPages(blocks: TemplateBlock[]): TemplateBlock[][] {
  const pages: TemplateBlock[][] = [];
  let currentPage: TemplateBlock[] = [];

  if (!blocks || blocks.length === 0) {
    return [[]]; // Return at least one empty page
  }

  blocks.forEach((block) => {
    if (block.block_type === "page_break") {
      // Push current page before the page break (even if empty)
      pages.push(currentPage);
      currentPage = [];
    } else {
      currentPage.push(block);
    }
  });

  // CRITICAL: Always add the last page, even if empty
  // This ensures the last page is always selectable
  pages.push(currentPage);

  return pages;
}

/**
 * Find which page a block belongs to
 * Uses the same logic as splitBlocksIntoPages for consistency
 * 
 * @param blockId - ID of the block to find
 * @param blocks - Array of template blocks
 * @returns Page index (0-based) where the block is located
 */
export function getPageIndexForBlock(blockId: string, blocks: TemplateBlock[]): number {
  let pageIndex = 0;

  for (const block of blocks) {
    // Check if this is the block we're looking for FIRST
    if (block.id === blockId) {
      return pageIndex;
    }

    // Only increment page index AFTER checking the block
    if (block.block_type === "page_break") {
      pageIndex++;
    }
  }

  // If not found, default to first page
  return 0;
}

/**
 * Split blocks into pages and track page breaks with their positions
 * Used for page deletion and reordering operations
 * 
 * @param blocks - Array of template blocks
 * @returns Object with pages array and pageBreakBlocks array with position info
 */
export function splitBlocksIntoPagesWithBreaks(blocks: TemplateBlock[]): {
  pages: TemplateBlock[][];
  pageBreakBlocks: Array<{ block: TemplateBlock; comesAfterPageIndex: number }>;
} {
  const pages: TemplateBlock[][] = [];
  const pageBreakBlocks: Array<{ block: TemplateBlock; comesAfterPageIndex: number }> = [];
  let currentPage: TemplateBlock[] = [];
  let currentPageIndex = 0;

  if (!blocks || blocks.length === 0) {
    return { pages: [[]], pageBreakBlocks: [] };
  }

  blocks.forEach((block) => {
    if (block.block_type === "page_break") {
      // Push current page before the page break
      pages.push(currentPage);
      // Store page_break with the page index it comes AFTER
      pageBreakBlocks.push({ block, comesAfterPageIndex: currentPageIndex });
      currentPageIndex++;
      currentPage = [];
    } else {
      currentPage.push(block);
    }
  });

  // Always add the last page
  pages.push(currentPage);

  return { pages, pageBreakBlocks };
}

