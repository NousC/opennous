/**
 * Extract graphics placeholders from template content
 *
 * Scans through all pages and blocks to find dataGraphicBlock nodes
 * and returns them as a list of graphics that can be filled in when
 * creating a document from the template.
 */

export interface GraphicPlaceholder {
  id: string;
  pageIndex: number;
  pageNumber: number;
  graphicType: string;
  label: string;
  variant?: string;
  currentRawText: string; // The current/mockup data in the template
  blockPath: string; // Path to find the block in the content
}

/**
 * Map graphic types to human-readable labels
 */
const GRAPHIC_TYPE_LABELS: Record<string, string> = {
  'timeline': 'Timeline',
  'scope': 'Scope',
  'pie_chart_numbers': 'Pie Chart',
  'pie_chart_text': 'Pie Chart (Text)',
  'pie_chart': 'Pie Chart',
  'line_chart': 'Line Chart',
  'table_comparison': 'Comparison Table',
  'metrics_column': 'Key Metrics',
  'metrics': 'Metrics',
  'key_information': 'Key Information',
  'mindmap': 'Mind Map',
  'journey': 'Customer Journey',
  'funnel': 'Funnel',
  'pyramid': 'Pyramid',
  'swot': 'SWOT Analysis',
  'brainstorm': 'Brainstorm',
  'profile': 'Profile',
  'process': 'Process',
};

/**
 * Get human-readable label for a graphic type
 */
export function getGraphicTypeLabel(graphicType: string): string {
  return GRAPHIC_TYPE_LABELS[graphicType] || graphicType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract all graphics from template content
 *
 * @param content - Template content (pages array with blocks) OR template_blocks array
 * @returns Array of graphic placeholders
 */
export function extractGraphicsFromTemplate(content: any): GraphicPlaceholder[] {
  const graphics: GraphicPlaceholder[] = [];

  if (!content) {
    return graphics;
  }

  // Handle template_blocks array format (from template_blocks table)
  if (Array.isArray(content)) {
    return extractGraphicsFromTemplateBlocks(content);
  }

  // Handle pages array format (legacy)
  if (!content.pages || !Array.isArray(content.pages)) {
    return graphics;
  }

  content.pages.forEach((page: any, pageIndex: number) => {
    if (!page) return;

    // Handle TipTap format (notion_content with doc structure)
    if (page.notion_content) {
      const notionContent = typeof page.notion_content === 'string'
        ? JSON.parse(page.notion_content)
        : page.notion_content;

      extractGraphicsFromTiptapContent(notionContent, pageIndex, graphics);
    }

    // Handle legacy block format
    if (page.blocks && Array.isArray(page.blocks)) {
      page.blocks.forEach((block: any, blockIndex: number) => {
        if (block.type === 'dataGraphicBlock' || block.block_type === 'dataGraphicBlock') {
          const attrs = block.attrs || block;
          const graphicType = attrs.graphicType || attrs.graphic_type || 'unknown';

          graphics.push({
            id: attrs.graphicId || `graphic_${pageIndex}_${blockIndex}`,
            pageIndex,
            pageNumber: pageIndex + 1,
            graphicType,
            label: getGraphicTypeLabel(graphicType),
            variant: attrs.variant,
            currentRawText: attrs.rawText || '',
            blockPath: `pages[${pageIndex}].blocks[${blockIndex}]`,
          });
        }
      });
    }
  });

  return graphics;
}

/**
 * Extract graphics from template_blocks array
 * Template blocks are stored with block_type and content
 */
function extractGraphicsFromTemplateBlocks(blocks: any[]): GraphicPlaceholder[] {
  const graphics: GraphicPlaceholder[] = [];

  // Count pages by tracking page_break blocks
  let pageIndex = 0;

  blocks.forEach((block: any, blockIndex: number) => {
    // Track page changes
    if (block.block_type === 'page_break') {
      pageIndex++;
      return;
    }

    // Only process notion_content blocks (TipTap format)
    if (block.block_type === 'notion_content') {
      let content = block.content;

      // Parse content if it's a string
      if (typeof content === 'string') {
        try {
          content = JSON.parse(content);
        } catch (e) {
          return;
        }
      }

      if (!content || typeof content !== 'object') {
        return;
      }

      // Content can be { html, text, tiptap } or direct TipTap doc
      // Check for nested tiptap structure
      const tiptapContent = content.tiptap || content;

      if (!tiptapContent || typeof tiptapContent !== 'object') {
        return;
      }

      // Extract graphics from TipTap content
      extractGraphicsFromTiptapContent(tiptapContent, pageIndex, graphics, blockIndex);
    }
  });

  return graphics;
}

/**
 * Recursively extract graphics from TipTap content structure
 */
function extractGraphicsFromTiptapContent(
  node: any,
  pageIndex: number,
  graphics: GraphicPlaceholder[],
  blockIndexOrPath: number | string = '',
  path: string = ''
): void {
  if (!node) return;

  // Determine the base path prefix based on whether we're using block index or page path
  const basePathPrefix = typeof blockIndexOrPath === 'number'
    ? `blocks[${blockIndexOrPath}]`
    : `pages[${pageIndex}].notion_content`;

  // Check if this node is a dataGraphicBlock
  if (node.type === 'dataGraphicBlock') {
    const attrs = node.attrs || {};
    const graphicType = attrs.graphicType || attrs.type || 'unknown';

    graphics.push({
      id: attrs.graphicId || `graphic_${pageIndex}_${graphics.length}`,
      pageIndex,
      pageNumber: pageIndex + 1,
      graphicType,
      label: getGraphicTypeLabel(graphicType),
      variant: attrs.variant,
      currentRawText: attrs.rawText || '',
      blockPath: `${basePathPrefix}${path}`,
    });
  }

  // Recursively check content array
  if (node.content && Array.isArray(node.content)) {
    node.content.forEach((child: any, index: number) => {
      extractGraphicsFromTiptapContent(child, pageIndex, graphics, blockIndexOrPath, `${path}.content[${index}]`);
    });
  }
}

/**
 * Get placeholder text/description for a graphic type
 */
export function getGraphicInputPlaceholder(graphicType: string): string {
  const placeholders: Record<string, string> = {
    'timeline': 'e.g., Week 1-2: Research, Week 3-6: Build and execute...',
    'scope': 'e.g., [globe] Website Development: Full-stack web application...\n[mail] Email Marketing: Automated campaigns...',
    'pie_chart_numbers': 'e.g., Organic Traffic: 45, Paid Ads: 30, Social: 15, Direct: 10',
    'pie_chart_text': 'e.g., SEO: Drives organic discovery, Paid: Targeted acquisition...',
    'pie_chart': 'e.g., Category A: 45, Category B: 30, Category C: 25',
    'line_chart': 'e.g., Monthly Revenue\nJanuary: 120, February: 145, March: 167...',
    'table_comparison': 'e.g., Feature | Basic | Pro\nUsers: 5 | 50\nStorage: 10GB | 100GB',
    'metrics_column': 'e.g., 47% Conversion Rate - Above average\n$2.5M Revenue - 40% growth\n15K+ Users',
    'metrics': 'e.g., 47% Conversion, $2.5M Revenue, 15K+ Users',
    'key_information': 'e.g., Fast Performance: Load times under 200ms\n24/7 Support: Team available anytime',
    'mindmap': 'e.g., Digital Strategy\nContent Marketing\n  - Blog Posts\n  - Videos\nSocial Media\n  - LinkedIn',
    'journey': 'e.g., Awareness: Customer discovers problem\nConsideration: Evaluates solutions\nDecision: Makes purchase',
    'funnel': 'e.g., Visitors: 100%\nLeads: 40%\nQualified: 20%\nCustomers: 5%',
    'pyramid': 'e.g., Vision: Long-term goals\nStrategy: How to achieve\nTactics: Specific actions',
    'swot': 'e.g., Strengths: Strong brand, Team\nWeaknesses: Budget, Market share\nOpportunities: New markets',
    'brainstorm': 'e.g., Growth Ideas\n- Expand markets\n- Launch referral program\n- Develop premium tier',
    'profile': 'e.g., Sarah, Marketing Director, 32-45, Goals: Increase team productivity',
    'process': 'e.g., Step 1: Research requirements\nStep 2: Design solution\nStep 3: Implement',
    'stat': 'e.g., 47% or $2.5M or 15K+',
  };

  return placeholders[graphicType] || 'Enter data for this graphic...';
}

/**
 * Get detailed format instructions for a graphic type
 */
export function getGraphicFormatInstructions(graphicType: string): string {
  const instructions: Record<string, string> = {
    'pie_chart_numbers': `Format: Label: Number (one per line)
Example:
Organic Traffic: 45
Paid Advertising: 30
Social Media: 15
Direct: 10`,

    'pie_chart_text': `Format: Label: Description (one per line)
Example:
SEO: Drives organic discovery
Paid Ads: Targeted customer acquisition
Referrals: Word of mouth recommendations`,

    'line_chart': `Format: Title on first line, then Label: Value
Example:
Monthly Revenue ($K)
January: 120
February: 145
March: 138
April: 167`,

    'table_comparison': `Format: Feature | Option1 | Option2 | Option3
Example:
Feature | Basic | Pro | Enterprise
Users | 5 | 50 | Unlimited
Storage | 10GB | 100GB | 1TB`,

    'metrics_column': `Format: Value Label - Description (one per line)
Example:
47% Conversion Rate - Above industry average
$2.5M Annual Revenue - 40% YoY growth
15K+ Active Users - Monthly active users`,

    'key_information': `Format: Title: Description (one per line)
Example:
Fast Performance: Load times under 200ms
Enterprise Security: SOC 2 compliant
24/7 Support: Available around the clock`,

    'timeline': `Format: Week/Duration: Description
Example:
Week 1-2: Research and analysis
Week 3: Strategy development
Week 4-8: Build and deploy`,

    'scope': `Format: [icon] Title: Description (icon optional: globe, mail, search, file-text)
Example:
[globe] Website Development: Full-stack web application with responsive design
[mail] Email Marketing: Automated campaigns and newsletter management
[search] SEO Optimization: On-page and technical SEO improvements`,

    'mindmap': `Format: Central topic first, then branches, indent children with spaces
Example:
Digital Marketing Strategy
Content Marketing
  - Blog Posts
  - Video Content
Social Media
  - LinkedIn
  - Twitter`,

    'swot': `Format: Category: items separated by commas
Example:
Strengths: Strong brand, Experienced team
Weaknesses: Limited budget, Small market share
Opportunities: Emerging markets, Partnerships
Threats: Competition, Economic downturn`,

    'funnel': `Format: Stage: Percentage - Description
Example:
Visitors: 100% - All website visitors
Leads: 40% - Captured contact info
Qualified: 20% - Met criteria
Customers: 5% - Converted`,

    'journey': `Format: Stage: Description
Example:
Awareness: Customer discovers the problem
Consideration: Evaluates potential solutions
Decision: Chooses the best option
Success: Achieves desired outcomes`,

    'pyramid': `Format: Level: Description (top to bottom)
Example:
Vision: Long-term strategic goals
Strategy: How to achieve the vision
Tactics: Specific actions
Operations: Day-to-day execution`,

    'brainstorm': `Format: Title first, then ideas with -
Example:
Growth Strategies
- Expand to new markets
- Launch referral program
- Develop premium tier`,

    'stat': `Format: Single value with optional label
Example: 47% or $2.5M Revenue or 15K+ Users`,

    'profile': `Format: Name, Role, Details
Example:
Sarah Johnson
Marketing Director, Age 32-45
Goals: Increase team productivity
Challenges: Limited budget`,
  };

  return instructions[graphicType] || `Enter data in a logical format. The AI will parse and format it for the ${graphicType} graphic.`;
}
