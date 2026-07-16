import { useLocation } from "react-router-dom";

const TITLES: Record<string, string> = {
  "/playground": "Playground",
};

export default function ComingSoon() {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? "Coming soon";

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 bg-background">
      <h1 className="text-[18px] font-bold text-foreground tracking-tight">{title}</h1>
      <p className="text-[13px] text-muted-foreground mt-1.5">This section is coming soon.</p>
    </div>
  );
}
