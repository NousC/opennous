// Dev-only entry (GET-416): the revenue report's fixture sections through the real renderer,
// with nothing else — no Clerk, no router, no app shell. Open /preview.html on a dev server.
import { createRoot } from "react-dom/client";
import "../index.css";
import ReportPreview from "@/pages/dev/ReportPreview";

createRoot(document.getElementById("root")!).render(<ReportPreview />);
