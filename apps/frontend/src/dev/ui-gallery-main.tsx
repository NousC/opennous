// Dev-only entry (GET-594): every interface-refresh primitive on one page, with fixture data,
// so each can be checked against the design canvas without the app shell, Clerk or the API.
// Open /ui-gallery.html on a dev server; add ?theme=dark for the dark tokens.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import UiGallery from "@/pages/dev/UiGallery";

if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider delayDuration={300}>
        <UiGallery />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
