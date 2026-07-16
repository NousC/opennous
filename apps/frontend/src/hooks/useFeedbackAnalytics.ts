import { useState, useEffect } from 'react';
import { useAuth } from './useAuth';

interface SectionPerformance {
  section: string;
  positive: number;
  negative: number;
  rate: number;
}

interface StylePerformance {
  style: string;
  count: number;
  avgRating: string;
}

export interface FeedbackSummary {
  period: string;
  totalDocuments: number;
  avgDocumentRating: string | null;
  totalPageRatings: number;
  positivePages: number;
  negativePages: number;
  pagePositiveRate: number | null;
  byStyle: StylePerformance[];
  topSections: SectionPerformance[];
  worstSections: SectionPerformance[];
}

interface PatternInsight {
  pattern: string;
  confidence: number;
  insight: string;
  recommendation?: string;
}

export interface PatternGuidance {
  positive: PatternInsight[];
  negative: PatternInsight[];
  sampleSize: {
    positive: number;
    negative: number;
  };
}

interface OptimalMetrics {
  sectionType: string;
  designStyle: string;
  sampleSize: number;
  wordCount: {
    optimal: number;
    min: number;
    max: number;
  } | null;
  blockCount: {
    optimal: number;
    min: number;
    max: number;
  } | null;
  preferredGraphicType: string | null;
  preferredLayout: string | null;
  preferredDensity: string | null;
}

/**
 * Hook to fetch feedback summary for admin dashboard
 */
export function useFeedbackSummary(options?: {
  designStyle?: string;
  industry?: string;
  days?: number;
}) {
  const { session } = useAuth();
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSummary = async () => {
      if (!session?.access_token) {
        setLoading(false);
        setError('Not authenticated');
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        if (options?.designStyle) params.set('designStyle', options.designStyle);
        if (options?.industry) params.set('industry', options.industry);
        if (options?.days) params.set('days', String(options.days));

        const response = await fetch(`/api/ai-writer/feedback-summary?${params}`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch feedback summary');
        }

        const data = await response.json();
        setSummary(data.summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchSummary();
  }, [session?.access_token, options?.designStyle, options?.industry, options?.days]);

  return { summary, loading, error };
}

/**
 * Hook to fetch pattern-based guidance for a design style
 */
export function usePatternGuidance(designStyle: string, industry?: string) {
  const { session } = useAuth();
  const [guidance, setGuidance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!designStyle || !session?.access_token) {
      setLoading(false);
      return;
    }

    const fetchGuidance = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ designStyle });
        if (industry) params.set('industry', industry);

        const response = await fetch(`/api/ai-writer/pattern-guidance?${params}`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch pattern guidance');
        }

        const data = await response.json();
        setGuidance(data.guidance || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchGuidance();
  }, [session?.access_token, designStyle, industry]);

  return { guidance, loading, error };
}

/**
 * Hook to fetch optimal metrics for a section type
 */
export function useOptimalMetrics(designStyle: string, sectionType: string) {
  const { session } = useAuth();
  const [metrics, setMetrics] = useState<OptimalMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!designStyle || !sectionType || !session?.access_token) {
      setLoading(false);
      return;
    }

    const fetchMetrics = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ designStyle, sectionType });
        const response = await fetch(`/api/ai-writer/optimal-metrics?${params}`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch optimal metrics');
        }

        const data = await response.json();
        setMetrics(data.metrics || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
  }, [session?.access_token, designStyle, sectionType]);

  return { metrics, loading, error };
}
