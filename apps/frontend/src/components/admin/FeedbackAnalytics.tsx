import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ThumbsUp,
  ThumbsDown,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Loader2,
  AlertCircle,
  FileText,
  Palette
} from "lucide-react";
import { useFeedbackSummary } from "@/hooks/useFeedbackAnalytics";
import { cn } from "@/lib/utils";

const DESIGN_STYLES = [
  { value: 'all', label: 'All Styles' },
  { value: 'modern', label: 'Modern' },
  { value: 'creative', label: 'Creative' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'elegant', label: 'Elegant' },
  { value: 'minimalistic', label: 'Minimalistic' },
];

const TIME_PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

/**
 * Admin component showing feedback analytics and patterns.
 * Displays document ratings, page-level feedback, and section performance.
 */
export function FeedbackAnalytics() {
  const [selectedStyle, setSelectedStyle] = useState<string>('all');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('30');

  const { summary, loading, error } = useFeedbackSummary({
    designStyle: selectedStyle === 'all' ? undefined : selectedStyle,
    days: parseInt(selectedPeriod),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <AlertCircle className="h-5 w-5 mr-2" />
        <span>Failed to load feedback data</span>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <BarChart3 className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No feedback data yet</p>
        <p className="text-sm">Feedback will appear here once users start rating pages</p>
      </div>
    );
  }

  const positiveRate = summary.pagePositiveRate ?? 0;

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex items-center gap-4">
        <Select value={selectedStyle} onValueChange={setSelectedStyle}>
          <SelectTrigger className="w-[180px]">
            <Palette className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Design Style" />
          </SelectTrigger>
          <SelectContent>
            {DESIGN_STYLES.map(style => (
              <SelectItem key={style.value} value={style.value}>
                {style.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Time Period" />
          </SelectTrigger>
          <SelectContent>
            {TIME_PERIODS.map(period => (
              <SelectItem key={period.value} value={period.value}>
                {period.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Documents Rated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-blue-500" />
              <span className="text-2xl font-bold">{summary.totalDocuments}</span>
            </div>
            {summary.avgDocumentRating && (
              <p className="text-sm text-muted-foreground mt-1">
                Avg rating: {summary.avgDocumentRating}/10
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Page Ratings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-purple-500" />
              <span className="text-2xl font-bold">{summary.totalPageRatings}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-sm">
              <span className="text-green-600 flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" /> {summary.positivePages}
              </span>
              <span className="text-red-600 flex items-center gap-1">
                <ThumbsDown className="h-3 w-3" /> {summary.negativePages}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Positive Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {positiveRate >= 70 ? (
                <TrendingUp className="h-5 w-5 text-green-500" />
              ) : positiveRate >= 50 ? (
                <TrendingUp className="h-5 w-5 text-yellow-500" />
              ) : (
                <TrendingDown className="h-5 w-5 text-red-500" />
              )}
              <span className="text-2xl font-bold">{positiveRate}%</span>
            </div>
            <Progress
              value={positiveRate}
              className="h-2 mt-2"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Time Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.period}</div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Analysis */}
      <Tabs defaultValue="sections" className="w-full">
        <TabsList>
          <TabsTrigger value="sections">Section Performance</TabsTrigger>
          <TabsTrigger value="styles">By Design Style</TabsTrigger>
        </TabsList>

        <TabsContent value="sections" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top Performing Sections */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  Top Performing Sections
                </CardTitle>
                <CardDescription>
                  Sections with highest positive ratings
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.topSections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No data yet</p>
                ) : (
                  <div className="space-y-3">
                    {summary.topSections.slice(0, 5).map((section, idx) => (
                      <div key={section.section} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono text-xs">
                            {idx + 1}
                          </Badge>
                          <span className="capitalize">
                            {section.section.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-sm font-medium",
                            section.rate >= 70 ? "text-green-600" :
                            section.rate >= 50 ? "text-yellow-600" : "text-red-600"
                          )}>
                            {section.rate}%
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ({section.positive + section.negative} votes)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Worst Performing Sections */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500" />
                  Needs Improvement
                </CardTitle>
                <CardDescription>
                  Sections with most negative ratings
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.worstSections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No data yet</p>
                ) : (
                  <div className="space-y-3">
                    {summary.worstSections.slice(0, 5).map((section, idx) => (
                      <div key={section.section} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="destructive" className="font-mono text-xs">
                            {idx + 1}
                          </Badge>
                          <span className="capitalize">
                            {section.section.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-red-600">
                            {section.rate}% negative
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ({section.negative} votes)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="styles" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Palette className="h-4 w-4" />
                Performance by Design Style
              </CardTitle>
              <CardDescription>
                Average document rating per design style
              </CardDescription>
            </CardHeader>
            <CardContent>
              {summary.byStyle.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data yet</p>
              ) : (
                <div className="space-y-4">
                  {summary.byStyle.map((style) => {
                    const rating = parseFloat(style.avgRating);
                    return (
                      <div key={style.style} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="capitalize font-medium">
                            {style.style}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-sm font-medium",
                              rating >= 7 ? "text-green-600" :
                              rating >= 5 ? "text-yellow-600" : "text-red-600"
                            )}>
                              {style.avgRating}/10
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {style.count} docs
                            </Badge>
                          </div>
                        </div>
                        <Progress
                          value={rating * 10}
                          className="h-2"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
