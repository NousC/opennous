import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";

interface Parameter {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  default?: string;
}

interface EndpointDocProps {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  endpoint: string;
  title: string;
  description: string;
  pathParams?: Parameter[];
  queryParams?: Parameter[];
  bodyParams?: Parameter[];
  requestExample?: {
    curl?: string;
    javascript?: string;
    python?: string;
  };
  responseExample?: string;
  errorExample?: string;
}

const getMethodBadgeVariant = (method: string) => {
  switch (method) {
    case "GET":
      return "outline";
    case "POST":
      return "default";
    case "PATCH":
      return "outline";
    case "DELETE":
      return "destructive";
    default:
      return "outline";
  }
};

const getMethodColor = (method: string) => {
  switch (method) {
    case "POST":
      return "bg-green-600";
    case "DELETE":
      return "bg-red-600";
    default:
      return "";
  }
};

export function EndpointDoc({
  method,
  endpoint,
  title,
  description,
  pathParams = [],
  queryParams = [],
  bodyParams = [],
  requestExample,
  responseExample,
  errorExample,
}: EndpointDocProps) {
  const apiUrl = import.meta.env.VITE_API_URL ?? "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Left Column - Documentation */}
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Badge
              variant={getMethodBadgeVariant(method)}
              className={cn("font-mono", getMethodColor(method))}
            >
              {method}
            </Badge>
            <code className="text-lg font-mono">{endpoint}</code>
          </div>
          <p className="text-muted-foreground leading-relaxed">{description}</p>
        </div>

        {/* Path Parameters */}
        {pathParams.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Path Parameters</h3>
            <div className="space-y-3">
              {pathParams.map((param) => (
                <div key={param.name} className="border-l-2 border-primary/20 pl-4">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {param.name}
                    </code>
                    <Badge variant="outline" className="text-xs">
                      {param.type}
                    </Badge>
                    {param.required && (
                      <Badge variant="destructive" className="text-xs">
                        required
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{param.description}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Query Parameters */}
        {queryParams.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Query Parameters</h3>
            <div className="space-y-3">
              {queryParams.map((param) => (
                <div key={param.name} className="border-l-2 border-primary/20 pl-4">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {param.name}
                    </code>
                    <Badge variant="outline" className="text-xs">
                      {param.type}
                    </Badge>
                    {param.required ? (
                      <Badge variant="destructive" className="text-xs">
                        required
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        optional
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{param.description}</p>
                  {param.default && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Default: <code>{param.default}</code>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Body Parameters */}
        {bodyParams.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Body Parameters</h3>
            <div className="space-y-3">
              {bodyParams.map((param) => (
                <div key={param.name} className="border-l-2 border-primary/20 pl-4">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {param.name}
                    </code>
                    <Badge variant="outline" className="text-xs">
                      {param.type}
                    </Badge>
                    {param.required ? (
                      <Badge variant="destructive" className="text-xs">
                        required
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        optional
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{param.description}</p>
                  {param.default && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Default: <code>{param.default}</code>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right Column - Examples */}
      <div className="space-y-6">
        {requestExample && (
          <div>
            <h3 className="text-lg font-semibold mb-3">{title}</h3>
            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
              </TabsList>
              <TabsContent value="curl" className="mt-4">
                <CodeBlock code={requestExample.curl || ""} />
              </TabsContent>
              <TabsContent value="javascript" className="mt-4">
                <CodeBlock code={requestExample.javascript || ""} language="javascript" />
              </TabsContent>
              <TabsContent value="python" className="mt-4">
                <CodeBlock code={requestExample.python || ""} language="python" />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {responseExample && (
          <div>
            <h3 className="text-lg font-semibold mb-3">200 Response</h3>
            <CodeBlock code={responseExample} language="json" />
          </div>
        )}

        {errorExample && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Error Response</h3>
            <CodeBlock code={errorExample} language="json" />
          </div>
        )}
      </div>
    </div>
  );
}

