import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Image, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BackgroundBundlesPanel } from "@/components/cms/BackgroundBundlesPanel";
import { ContentImagesPanel } from "@/components/cms/ContentImagesPanel";

export default function AdminMedia() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("bundles");

  return (
    <div className="flex h-screen bg-background font-sans">
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col bg-background">
        {/* Top Bar */}
        <div className="h-14 border-b border-border/40 px-6 flex items-center justify-between bg-background/80 backdrop-blur-sm sticky top-0 z-20">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 -ml-2"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="font-semibold text-lg tracking-tight">Media Library</div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="mb-6">
              <TabsTrigger value="bundles" className="flex items-center gap-2">
                <Package className="h-4 w-4" />
                Background Bundles
              </TabsTrigger>
              <TabsTrigger value="content-images" className="flex items-center gap-2">
                <Image className="h-4 w-4" />
                Content Images
              </TabsTrigger>
            </TabsList>

            <TabsContent value="bundles" className="mt-0">
              <BackgroundBundlesPanel />
            </TabsContent>

            <TabsContent value="content-images" className="mt-0">
              <ContentImagesPanel />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
