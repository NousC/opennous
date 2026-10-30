// Knowledge as a page in the app shell (GET-1082): what the Context Graph sidebar's Intelligence tree
// opens, so a file or the ICP opens without leaving that sidebar. The same section Settings draws:
// Cloud's when it has one (its ICP and Win/loss pages, ?page=), else the open-source library.
import { Suspense } from "react";
import { ContextLibrary } from "@/components/knowledge/ContextLibrary";
import { useAuth } from "@/contexts/AuthContext";
import { cloud } from "@/lib/cloud";

export default function Knowledge() {
  const { session, userData } = useAuth();
  const Section = cloud.settings?.sections?.context;
  if (Section) return <Suspense fallback={null}><Section token={session?.access_token ?? ""} workspaceId={userData?.workspace?.id ?? ""} /></Suspense>;
  return <ContextLibrary />;
}
