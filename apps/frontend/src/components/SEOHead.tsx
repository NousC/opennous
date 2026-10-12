import { useEffect } from 'react';

interface SEOHeadProps {
  title: string;
  description: string;
  canonicalUrl?: string;
  schema?: string;
  ogImage?: string;
  ogType?: 'website' | 'article';
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
}

export const SEOHead = ({
  title,
  description,
  canonicalUrl,
  schema,
  ogImage,
  ogType = 'website',
  publishedTime,
  modifiedTime,
  author
}: SEOHeadProps) => {
  useEffect(() => {
    // Update Title
    document.title = title;

    // Helper to update or create meta tag
    const updateMeta = (property: string, content: string, isProperty = false) => {
      const selector = isProperty
        ? `meta[property="${property}"]`
        : `meta[name="${property}"]`;
      let meta = document.querySelector(selector);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute(isProperty ? 'property' : 'name', property);
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', content);
    };

    // Update Meta Description
    updateMeta('description', description);

    // Update Open Graph tags
    updateMeta('og:title', title, true);
    updateMeta('og:description', description, true);
    updateMeta('og:type', ogType, true);

    if (canonicalUrl) {
      updateMeta('og:url', canonicalUrl, true);
    }

    if (ogImage) {
      updateMeta('og:image', ogImage, true);
    }

    // Update Twitter Card tags
    updateMeta('twitter:title', title);
    updateMeta('twitter:description', description);

    if (ogImage) {
      updateMeta('twitter:image', ogImage);
    }

    // Article-specific meta tags
    if (ogType === 'article') {
      if (publishedTime) {
        updateMeta('article:published_time', publishedTime, true);
      }
      if (modifiedTime) {
        updateMeta('article:modified_time', modifiedTime, true);
      }
      if (author) {
        updateMeta('article:author', author, true);
      }
    }

    // Update Canonical URL
    if (canonicalUrl) {
      let linkCanonical = document.querySelector('link[rel="canonical"]');
      if (!linkCanonical) {
        linkCanonical = document.createElement('link');
        linkCanonical.setAttribute('rel', 'canonical');
        document.head.appendChild(linkCanonical);
      }
      linkCanonical.setAttribute('href', canonicalUrl);
    }

    // Add JSON-LD Schema (page-specific, separate from global Organization schema)
    // Use a data attribute to distinguish page schemas from global ones
    if (schema) {
      // Remove any existing page-specific schema
      const existingPageSchema = document.querySelector('script[data-page-schema="true"]');
      if (existingPageSchema) {
        existingPageSchema.remove();
      }

      const scriptSchema = document.createElement('script');
      scriptSchema.setAttribute('type', 'application/ld+json');
      scriptSchema.setAttribute('data-page-schema', 'true');
      scriptSchema.textContent = schema;
      document.head.appendChild(scriptSchema);
    }

    return () => {
      // Clean up page-specific schema on unmount
      const pageSchema = document.querySelector('script[data-page-schema="true"]');
      if (pageSchema) {
        pageSchema.remove();
      }
    };
  }, [title, description, canonicalUrl, schema, ogImage, ogType, publishedTime, modifiedTime, author]);

  return null;
};

