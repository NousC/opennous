import {
  FileText,
  BarChart3,
  TrendingUp,
  Palette,
  Briefcase,
  Rocket,
  Star,
  Flame,
  Lightbulb,
  Target,
  PenTool,
  Sparkles,
  LucideIcon,
} from "lucide-react";

export const workspaceIcons = [
  { icon: FileText, name: "file" },
  { icon: BarChart3, name: "chart" },
  { icon: TrendingUp, name: "trend" },
  { icon: Palette, name: "palette" },
  { icon: Briefcase, name: "briefcase" },
  { icon: Rocket, name: "rocket" },
  { icon: Star, name: "star" },
  { icon: Flame, name: "flame" },
  { icon: Lightbulb, name: "lightbulb" },
  { icon: Target, name: "target" },
  { icon: PenTool, name: "pen" },
  { icon: Sparkles, name: "sparkles" },
] as const;

export type WorkspaceIconName = typeof workspaceIcons[number]["name"];

export function getWorkspaceIcon(iconName: string | null | undefined): LucideIcon | null {
  if (!iconName) return null;
  const iconItem = workspaceIcons.find(item => item.name === iconName);
  return iconItem ? iconItem.icon : null;
}

