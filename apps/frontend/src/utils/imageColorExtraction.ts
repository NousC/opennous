/**
 * Client-side image color extraction utilities
 * Extracts dominant/average color from images for background matching
 */

/**
 * Normalize a hex color to uppercase format
 * Ensures consistent color comparison throughout the app
 */
export function normalizeHexColor(color: string): string {
  if (!color) return '#FFFFFF';
  // Trim and uppercase
  const normalized = color.trim().toUpperCase();
  // Ensure it starts with #
  if (!normalized.startsWith('#')) {
    return `#${normalized}`;
  }
  // Expand shorthand hex (e.g., #FFF -> #FFFFFF)
  if (normalized.length === 4) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return normalized;
}

/**
 * Extract average color from an image URL
 * Returns a hex color string (uppercase)
 */
export async function extractColorFromImage(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          resolve('#FFFFFF'); // Fallback to white
          return;
        }
        
        ctx.drawImage(img, 0, 0);
        
        // Sample pixels (every 10th pixel for performance)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        let r = 0, g = 0, b = 0, count = 0;
        
        // Sample every 10th pixel for performance
        for (let i = 0; i < data.length; i += 40) { // RGBA = 4 bytes, so 40 = 10 pixels
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
        
        if (count > 0) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);

          // Convert to hex (uppercase for consistency)
          const hex = `#${r.toString(16).padStart(2, '0').toUpperCase()}${g.toString(16).padStart(2, '0').toUpperCase()}${b.toString(16).padStart(2, '0').toUpperCase()}`;
          resolve(hex);
        } else {
          resolve('#FFFFFF');
        }
      } catch (error) {
        console.warn('[IMAGE_COLOR_EXTRACT] Error extracting color:', error);
        resolve('#FFFFFF');
      }
    };
    
    img.onerror = () => {
      console.warn('[IMAGE_COLOR_EXTRACT] Failed to load image:', imageUrl);
      resolve('#FFFFFF'); // Fallback to white
    };
    
    img.src = imageUrl;
  });
}

/**
 * Get background color from page background settings
 * Extracts color from image if background_color is not set
 * Always returns normalized uppercase hex color for consistency
 */
export async function getBackgroundColorFromPageSettings(
  pageBg: { background_color?: string | null; background_image?: string | null } | null | undefined
): Promise<string> {
  if (!pageBg) {
    return '#FFFFFF';
  }

  // If solid color is set, use it (normalized to uppercase)
  if (pageBg.background_color) {
    return normalizeHexColor(pageBg.background_color);
  }

  // If background image exists, extract color from it
  if (pageBg.background_image) {
    try {
      const extractedColor = await extractColorFromImage(pageBg.background_image);
      return extractedColor; // Already normalized in extractColorFromImage
    } catch (error) {
      console.warn('[IMAGE_COLOR_EXTRACT] Failed to extract color from background image:', error);
      return '#FFFFFF';
    }
  }

  // Default to white
  return '#FFFFFF';
}

/**
 * Synchronous version that returns a cached color or default
 * Use this when you need immediate color (for initial render)
 * The async version will update it later
 * Always returns normalized uppercase hex color for consistency
 */
export function getBackgroundColorSync(
  pageBg: { background_color?: string | null; background_image?: string | null } | null | undefined
): string {
  if (!pageBg) {
    return '#FFFFFF';
  }

  // If solid color is set, use it (normalized to uppercase)
  if (pageBg.background_color) {
    return normalizeHexColor(pageBg.background_color);
  }

  // If background image exists but no color, default to white for now
  // The async version will extract the actual color
  return '#FFFFFF';
}
