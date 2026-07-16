import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, TestTube2, CheckCircle2, XCircle, Plus, Minus } from "lucide-react";
import { toast } from "@/components/ui/sonner";

interface Integration {
  id: string;
  contact_id: string;
  provider_connection_id: string;
  config: Record<string, any>;
  status: string;
  status_message?: string;
  cached_preview?: Record<string, any>;
  provider_connection: {
    id: string;
    name: string;
    provider: {
      id: string;
      name: string;
      display_name: string;
      logo_url?: string;
    };
  };
}

interface WorkspaceConnection {
  id: string;
  name: string;
  provider_id: string;
  is_verified: boolean;
  provider: {
    id: string;
    name: string;
    display_name: string;
    logo_url?: string;
    category: string;
  };
}

interface ConnectedDataConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  workspaceId: string;
  availableConnections: WorkspaceConnection[];
  existingIntegration?: Integration | null;
  onSave: (integration: Integration) => void;
  onDelete: (integrationId: string) => void;
}

export function ConnectedDataConfigModal({
  open,
  onOpenChange,
  contactId,
  workspaceId,
  availableConnections,
  existingIntegration,
  onSave,
  onDelete
}: ConnectedDataConfigModalProps) {
  const { session } = useAuth();
  const [selectedConnection, setSelectedConnection] = useState<string>("");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; preview?: any; error?: string } | null>(null);

  // Provider-specific resource loading
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [customFields, setCustomFields] = useState<{ id: string; name: string; type: string }[]>([]);
  const [loadingCustomFields, setLoadingCustomFields] = useState(false);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string; status?: string }[]>([]);
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [notionDatabases, setNotionDatabases] = useState<{ id: string; name: string }[]>([]);
  const [gaProperties, setGaProperties] = useState<{ id: string; propertyId: string; displayName: string; account: string }[]>([]);
  const [loadingResources, setLoadingResources] = useState(false);

  const isEditing = !!existingIntegration;

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      if (existingIntegration) {
        setSelectedConnection(existingIntegration.provider_connection_id);
        setConfig(existingIntegration.config || {});
      } else {
        setSelectedConnection("");
        setConfig({});
      }
      setTestResult(null);
    }
  }, [open, existingIntegration]);

  // Load resources when connection changes
  useEffect(() => {
    if (selectedConnection) {
      loadProviderResources();
    }
  }, [selectedConnection]);

  const getSelectedProvider = () => {
    if (existingIntegration) {
      return existingIntegration.provider_connection?.provider;
    }
    const conn = availableConnections.find(c => c.id === selectedConnection);
    return conn?.provider;
  };

  const loadProviderResources = async () => {
    if (!session?.access_token || !selectedConnection) return;

    const provider = getSelectedProvider();
    if (!provider) return;

    setLoadingResources(true);
    const apiUrl = import.meta.env.VITE_API_URL ?? "";

    try {
      switch (provider.name) {
        case "clickup":
          // Load ClickUp teams
          const teamsRes = await fetch(`${apiUrl}/api/workflow-providers/clickup/teams?connection_id=${selectedConnection}`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
          });
          if (teamsRes.ok) {
            const teamsData = await teamsRes.json();
            setTeams(teamsData.teams || []);
          }
          break;

        case "hubspot":
          // Load HubSpot pipelines
          const pipelinesRes = await fetch(`${apiUrl}/api/workflow-providers/hubspot/pipelines?connection_id=${selectedConnection}`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
          });
          if (pipelinesRes.ok) {
            const pipelinesData = await pipelinesRes.json();
            setPipelines(pipelinesData.pipelines || []);
          }
          break;

        case "pipedrive":
          // Load Pipedrive pipelines
          const pdPipelinesRes = await fetch(`${apiUrl}/api/workflow-providers/pipedrive/pipelines?connection_id=${selectedConnection}`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
          });
          if (pdPipelinesRes.ok) {
            const pdPipelinesData = await pdPipelinesRes.json();
            setPipelines(pdPipelinesData.pipelines || []);
          }
          break;

        case "notion":
          // Load Notion databases
          const notionDbRes = await fetch(`${apiUrl}/api/workflow-providers/notion/databases?connection_id=${selectedConnection}`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
          });
          if (notionDbRes.ok) {
            const notionDbData = await notionDbRes.json();
            setNotionDatabases(notionDbData.databases || []);
          } else {
            console.error('[ConnectedDataConfig] Failed to load Notion databases:', notionDbRes.status);
            setNotionDatabases([]);
          }
          break;

        case "google_analytics":
          // Load Google Analytics properties
          const gaRes = await fetch(`${apiUrl}/api/workflow-providers/google-analytics/properties?connection_id=${selectedConnection}`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
          });
          if (gaRes.ok) {
            const gaData = await gaRes.json();
            setGaProperties(gaData.properties || []);
          } else {
            console.error('[ConnectedDataConfig] Failed to load GA properties:', gaRes.status);
            setGaProperties([]);
          }
          break;
      }
    } catch (error) {
      console.error("Error loading provider resources:", error);
    } finally {
      setLoadingResources(false);
    }
  };

  const loadClickUpSpaces = async (teamId: string) => {
    if (!session?.access_token) return;

    const apiUrl = import.meta.env.VITE_API_URL ?? "";
    const res = await fetch(`${apiUrl}/api/workflow-providers/clickup/spaces?connection_id=${selectedConnection}&team_id=${teamId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (res.ok) {
      const data = await res.json();
      setSpaces(data.spaces || []);
      setFolders([]);
      setLists([]);
    }
  };

  const loadClickUpFolders = async (spaceId: string) => {
    if (!session?.access_token) return;

    const apiUrl = import.meta.env.VITE_API_URL ?? "";
    const res = await fetch(`${apiUrl}/api/workflow-providers/clickup/folders?connection_id=${selectedConnection}&space_id=${spaceId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (res.ok) {
      const data = await res.json();
      setFolders(data.folders || []);
      setLists([]);
    }
  };

  const loadClickUpLists = async (spaceOrFolderId: string, isFolder: boolean) => {
    if (!session?.access_token) return;

    const apiUrl = import.meta.env.VITE_API_URL ?? "";
    const endpoint = isFolder
      ? `clickup/lists?connection_id=${selectedConnection}&folder_id=${spaceOrFolderId}`
      : `clickup/lists?connection_id=${selectedConnection}&space_id=${spaceOrFolderId}`;
    const res = await fetch(`${apiUrl}/api/workflow-providers/${endpoint}`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (res.ok) {
      const data = await res.json();
      setLists(data.lists || []);
    }
  };

  // Load ALL lists from a space (including from all folders)
  const loadClickUpAllLists = async (spaceId: string) => {
    if (!session?.access_token) return;

    setLoadingResources(true);
    setLists([]);

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const res = await fetch(`${apiUrl}/api/workflow-providers/clickup/lists?connection_id=${selectedConnection}&space_id=${spaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setLists(data.lists || []);
      }
    } catch (error) {
      console.error('[ClickUp] Error loading lists:', error);
    } finally {
      setLoadingResources(false);
    }
  };

  const loadClickUpCustomFields = async (listId: string) => {
    if (!session?.access_token) return;

    setLoadingCustomFields(true);
    setCustomFields([]);

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const res = await fetch(`${apiUrl}/api/workflow-providers/clickup/fields?connection_id=${selectedConnection}&list_id=${listId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setCustomFields(data.fields || []);
      } else {
        const errorText = await res.text();
        console.error('[ClickUp] Failed to load fields:', res.status, errorText);
        setCustomFields([]);
      }
    } catch (error) {
      console.error('[ClickUp] Error loading fields:', error);
      setCustomFields([]);
    } finally {
      setLoadingCustomFields(false);
    }
  };

  const handleTest = async () => {
    if (!session?.access_token) return;

    setTesting(true);
    setTestResult(null);

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";

      if (isEditing && existingIntegration) {
        // Test existing integration
        const res = await fetch(`${apiUrl}/api/contacts/${contactId}/integrations/${existingIntegration.id}/test`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const data = await res.json();
        setTestResult(data);
      } else {
        // Create and test new integration
        const res = await fetch(`${apiUrl}/api/contacts/${contactId}/integrations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            provider_connection_id: selectedConnection,
            config
          })
        });
        const data = await res.json();

        if (data.integration) {
          onSave(data.integration);
          setTestResult(data.test_result);
          toast.success("Integration added");
          onOpenChange(false);
        } else {
          setTestResult({ success: false, error: data.error || "Failed to add integration" });
        }
      }
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!session?.access_token || !selectedConnection) return;

    setSaving(true);
    setTestResult(null);

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";

      if (isEditing && existingIntegration) {
        // Update existing - this will auto-test
        const res = await fetch(`${apiUrl}/api/contacts/${contactId}/integrations/${existingIntegration.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ config })
        });
        const data = await res.json();

        if (data.integration) {
          onSave(data.integration);
          // Show test result feedback
          if (data.test_result) {
            setTestResult(data.test_result);
            if (data.test_result.success) {
              toast.success("Configuration updated and verified");
              onOpenChange(false);
            } else {
              toast.error(data.test_result.error || "Connection test failed");
            }
          } else {
            toast.success("Configuration updated");
            onOpenChange(false);
          }
        } else {
          toast.error(data.error || "Failed to update");
        }
      } else {
        // Create new - use handleTest which also creates
        handleTest();
        return;
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = async () => {
    if (!existingIntegration) return;
    onDelete(existingIntegration.id);
    onOpenChange(false);
  };

  // Check if config is valid for the selected provider
  const isConfigValid = () => {
    const provider = getSelectedProvider();
    if (!provider) return false;

    switch (provider.name) {
      case "clickup":
        // ClickUp requires list_id AND filter_method
        if (!config.list_id || !config.filter_method) return false;
        // If custom field filter, must have custom_field_id
        if (config.filter_method === "custom_field" && !config.custom_field_id) return false;
        return true;
      case "hubspot":
        return !!config.pipeline_id;
      case "pipedrive":
        // Must select a resource type
        return !!config.resource_type;
      case "airtable":
        return !!config.base_id && !!config.table_id;
      case "mailchimp":
        return !!config.list_id;
      case "notion":
        return !!config.database_id;
      default:
        return true; // Other providers don't require specific config
    }
  };

  const provider = getSelectedProvider();

  const renderProviderConfig = () => {
    if (!provider) return null;

    switch (provider.name) {
      case "clickup":
        return (
          <div className="space-y-4">
            {/* Team */}
            <div>
              <Label className="text-xs">Team (Workspace)</Label>
              <Select
                value={config.team_id || ""}
                onValueChange={(value) => {
                  setConfig({ ...config, team_id: value, space_id: "", folder_id: "", list_id: "" });
                  loadClickUpSpaces(value);
                }}
                disabled={loadingResources}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select team" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map(team => (
                    <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Space */}
            {config.team_id && spaces.length > 0 && (
              <div>
                <Label className="text-xs">Space</Label>
                <Select
                  value={config.space_id || ""}
                  onValueChange={(value) => {
                    setConfig({ ...config, space_id: value, list_id: "", filter_method: "", custom_field_id: "" });
                    // Load ALL lists from this space (including from all folders)
                    loadClickUpAllLists(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select space" />
                  </SelectTrigger>
                  <SelectContent>
                    {spaces.map(space => (
                      <SelectItem key={space.id} value={space.id}>{space.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* List - shows ALL lists from all folders */}
            {config.space_id && lists.length > 0 && (
              <div>
                <Label className="text-xs">List</Label>
                <Select
                  value={config.list_id || ""}
                  onValueChange={(value) => {
                    setConfig({ ...config, list_id: value, filter_method: "", custom_field_id: "" });
                    if (value) {
                      loadClickUpCustomFields(value);
                    }
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select list" />
                  </SelectTrigger>
                  <SelectContent>
                    {lists.map(list => (
                      <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Filter Method - REQUIRED */}
            {config.list_id && (
              <div className="border-t pt-3 mt-2">
                <Label className="text-xs font-medium">Filter Tasks By <span className="text-red-500">*</span></Label>
                <p className="text-[11px] text-gray-500 mb-2">How should we find tasks for this contact?</p>

                <div className="space-y-3">
                  <Select
                    value={config.filter_method || ""}
                    onValueChange={(value) => setConfig({ ...config, filter_method: value, custom_field_id: "" })}
                  >
                    <SelectTrigger className={!config.filter_method ? "border-red-200" : ""}>
                      <SelectValue placeholder="Select filter method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="task_name_contact">Task Name contains Contact Name</SelectItem>
                      <SelectItem value="task_name_company">Task Name contains Company Name</SelectItem>
                      <SelectItem value="custom_field">Custom Field contains Contact Name</SelectItem>
                    </SelectContent>
                  </Select>

                  {config.filter_method === "custom_field" && (
                    <div>
                      <Label className="text-xs">Select Custom Field <span className="text-red-500">*</span></Label>
                      <Select
                        value={config.custom_field_id || ""}
                        onValueChange={(value) => setConfig({ ...config, custom_field_id: value })}
                        disabled={loadingCustomFields}
                      >
                        <SelectTrigger className={`mt-1 ${!config.custom_field_id ? "border-red-200" : ""}`}>
                          <SelectValue placeholder={loadingCustomFields ? "Loading..." : "Select field"} />
                        </SelectTrigger>
                        <SelectContent>
                          {loadingCustomFields ? (
                            <SelectItem value="loading" disabled>Loading fields...</SelectItem>
                          ) : customFields.length === 0 ? (
                            <SelectItem value="none" disabled>No custom fields found in this list</SelectItem>
                          ) : (
                            customFields.map(field => (
                              <SelectItem key={field.id} value={field.id}>{field.name}</SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-gray-400 mt-1">
                        Tasks where this field contains the contact's name will be shown
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case "hubspot":
        return (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Pipeline</Label>
              <Select
                value={config.pipeline_id || ""}
                onValueChange={(value) => setConfig({ ...config, pipeline_id: value })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select pipeline" />
                </SelectTrigger>
                <SelectContent>
                  {pipelines.map(pipeline => (
                    <SelectItem key={pipeline.id} value={pipeline.id}>{pipeline.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs">Match Company By</Label>
              <Select
                value={config.company_match_field || "name"}
                onValueChange={(value) => setConfig({ ...config, company_match_field: value })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">Company Name</SelectItem>
                  <SelectItem value="email_domain">Email Domain</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );

      case "pipedrive":
        return (
          <div className="space-y-4">
            {/* Resource Type selector */}
            <div>
              <Label className="text-xs font-medium">What do you want to fetch? <span className="text-red-500">*</span></Label>
              <Select
                value={config.resource_type || ""}
                onValueChange={(value) => setConfig({
                  ...config,
                  resource_type: value,
                  filter_value: "",
                  pipeline_id: ""
                })}
              >
                <SelectTrigger className={`mt-1 ${!config.resource_type ? "border-red-200" : ""}`}>
                  <SelectValue placeholder="Select resource type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deals">Deals</SelectItem>
                  <SelectItem value="contacts">Contacts (Persons)</SelectItem>
                  <SelectItem value="leads">Leads</SelectItem>
                  <SelectItem value="projects">Projects</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Pipeline selector (only for Deals) */}
            {config.resource_type === "deals" && pipelines.length > 0 && (
              <div>
                <Label className="text-xs">Pipeline (optional)</Label>
                <Select
                  value={config.pipeline_id || "all"}
                  onValueChange={(value) => setConfig({ ...config, pipeline_id: value === "all" ? "" : value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="All pipelines" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All pipelines</SelectItem>
                    {pipelines.map(pipeline => (
                      <SelectItem key={pipeline.id} value={String(pipeline.id)}>{pipeline.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Filter/Search - shown when resource type is selected */}
            {config.resource_type && (
              <div className="border-t pt-3">
                <Label className="text-xs font-medium">
                  Search {config.resource_type === "deals" ? "Deals" :
                          config.resource_type === "contacts" ? "Contacts" :
                          config.resource_type === "leads" ? "Leads" : "Projects"} by Name
                </Label>
                <Input
                  value={config.filter_value || ""}
                  onChange={(e) => setConfig({ ...config, filter_value: e.target.value })}
                  placeholder={
                    config.resource_type === "deals" ? "e.g., Website Redesign" :
                    config.resource_type === "contacts" ? "e.g., John Smith" :
                    config.resource_type === "leads" ? "e.g., New Lead" :
                    "e.g., Project Alpha"
                  }
                  className="mt-1"
                />
                <p className="text-[10px] text-gray-400 mt-1">
                  {config.resource_type === "deals" && "Search deals by title"}
                  {config.resource_type === "contacts" && "Search contacts/persons by name or email"}
                  {config.resource_type === "leads" && "Search leads by title"}
                  {config.resource_type === "projects" && "Search projects by title"}
                </p>
              </div>
            )}

            {/* Additional filter by org/person for deals */}
            {config.resource_type === "deals" && (
              <div>
                <Label className="text-xs">Additional Filter (optional)</Label>
                <Select
                  value={config.additional_filter || "none"}
                  onValueChange={(value) => setConfig({
                    ...config,
                    additional_filter: value === "none" ? "" : value,
                    additional_filter_value: ""
                  })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="No additional filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No additional filter</SelectItem>
                    <SelectItem value="person">Filter by Person Name</SelectItem>
                    <SelectItem value="organization">Filter by Organization Name</SelectItem>
                  </SelectContent>
                </Select>

                {config.additional_filter && config.additional_filter !== "none" && (
                  <Input
                    value={config.additional_filter_value || ""}
                    onChange={(e) => setConfig({ ...config, additional_filter_value: e.target.value })}
                    placeholder={config.additional_filter === "person" ? "Person name..." : "Organization name..."}
                    className="mt-2"
                  />
                )}
              </div>
            )}
          </div>
        );

      case "stripe":
        return (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Customer ID</Label>
              <Input
                value={config.customer_id || ""}
                onChange={(e) => setConfig({ ...config, customer_id: e.target.value })}
                placeholder="cus_XXXXXXXXX"
                className="mt-1"
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Find customer ID in Stripe Dashboard under Customers
              </p>
            </div>
          </div>
        );

      case "airtable":
        return (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Base ID</Label>
              <Input
                value={config.base_id || ""}
                onChange={(e) => setConfig({ ...config, base_id: e.target.value })}
                placeholder="appXXXXXXXXXXXXXX"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Table Name or ID</Label>
              <Input
                value={config.table_id || ""}
                onChange={(e) => setConfig({ ...config, table_id: e.target.value })}
                placeholder="Contacts"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Filter Field (optional)</Label>
              <Input
                value={config.filter_field || ""}
                onChange={(e) => setConfig({ ...config, filter_field: e.target.value })}
                placeholder="Email field name to filter by"
                className="mt-1"
              />
            </div>
          </div>
        );

      case "mailchimp":
        return (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Audience/List ID</Label>
              <Input
                value={config.list_id || ""}
                onChange={(e) => setConfig({ ...config, list_id: e.target.value })}
                placeholder="abc123def"
                className="mt-1"
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Find this in Mailchimp: Audience &gt; Settings &gt; Audience name and defaults
              </p>
            </div>
          </div>
        );

      case "notion":
        return (
          <div className="space-y-4">
            {/* Database selector */}
            <div>
              <Label className="text-xs font-medium">Database <span className="text-red-500">*</span></Label>
              {loadingResources ? (
                <div className="mt-1 p-3 border rounded-lg flex items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400 mr-2" />
                  <span className="text-sm text-gray-500">Loading databases...</span>
                </div>
              ) : notionDatabases.length > 0 ? (
                <Select
                  value={config.database_id || ""}
                  onValueChange={(value) => setConfig({ ...config, database_id: value })}
                >
                  <SelectTrigger className={`mt-1 ${!config.database_id ? "border-red-200" : ""}`}>
                    <SelectValue placeholder="Select a database" />
                  </SelectTrigger>
                  <SelectContent>
                    {notionDatabases.map(db => (
                      <SelectItem key={db.id} value={db.id}>{db.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="mt-1 p-3 border rounded-lg bg-amber-50 text-amber-700 text-sm">
                  No databases found. Make sure you've shared databases with your Notion integration.
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-1">
                Select a Notion database to connect to this contact
              </p>
            </div>
          </div>
        );

      case "google_analytics":
        return (
          <div className="space-y-4">
            {/* Property selector */}
            <div>
              <Label className="text-xs font-medium">GA4 Property <span className="text-red-500">*</span></Label>
              {loadingResources ? (
                <div className="mt-1 p-3 border rounded-lg flex items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400 mr-2" />
                  <span className="text-sm text-gray-500">Loading properties...</span>
                </div>
              ) : gaProperties.length > 0 ? (
                <Select
                  value={config.property_id || ""}
                  onValueChange={(value) => setConfig({ ...config, property_id: value })}
                >
                  <SelectTrigger className={`mt-1 ${!config.property_id ? "border-red-200" : ""}`}>
                    <SelectValue placeholder="Select a property" />
                  </SelectTrigger>
                  <SelectContent>
                    {gaProperties.map(prop => (
                      <SelectItem key={prop.propertyId} value={prop.propertyId}>
                        <div className="flex flex-col">
                          <span>{prop.displayName}</span>
                          <span className="text-xs text-gray-400">{prop.account}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="mt-1 p-3 border rounded-lg bg-amber-50 text-amber-700 text-sm">
                  No GA4 properties found. Make sure you have access to Google Analytics properties.
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-1">
                Select the GA4 property to pull metrics from for this contact's reports
              </p>
            </div>

            {/* Date Range selector */}
            {config.property_id && (
              <div>
                <Label className="text-xs">Date Range</Label>
                <Select
                  value={config.date_range?.startDate || "30daysAgo"}
                  onValueChange={(value) => setConfig({
                    ...config,
                    date_range: {
                      startDate: value,
                      endDate: "today"
                    }
                  })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select date range" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7daysAgo">Last 7 days</SelectItem>
                    <SelectItem value="30daysAgo">Last 30 days</SelectItem>
                    <SelectItem value="90daysAgo">Last 90 days</SelectItem>
                    <SelectItem value="365daysAgo">Last 12 months</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-gray-400 mt-1">
                  Default date range for pulling analytics data
                </p>
              </div>
            )}
          </div>
        );

      default:
        return (
          <p className="text-sm text-gray-500">
            Configuration not available for this provider yet.
          </p>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Configure Integration" : "Add Integration"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the configuration for this integration"
              : "Connect data from your integrations to this contact"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Connection Selection (only when adding new) */}
          {!isEditing && (
            <div>
              <Label className="text-xs">Integration</Label>
              <Select value={selectedConnection} onValueChange={setSelectedConnection}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select an integration" />
                </SelectTrigger>
                <SelectContent>
                  {availableConnections.map(conn => (
                    <SelectItem key={conn.id} value={conn.id}>
                      <div className="flex items-center gap-2">
                        {conn.provider?.logo_url && (
                          <img
                            src={conn.provider.logo_url}
                            alt=""
                            className="w-4 h-4 object-contain"
                          />
                        )}
                        <span>{conn.provider?.display_name}</span>
                        <span className="text-gray-400">({conn.name})</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Provider Name (when editing) */}
          {isEditing && provider && (
            <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
              {provider.logo_url && (
                <img src={provider.logo_url} alt="" className="w-5 h-5 object-contain" />
              )}
              <span className="font-medium text-sm">{provider.display_name}</span>
            </div>
          )}

          {/* Loading */}
          {loadingResources && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              <span className="ml-2 text-sm text-gray-500">Loading resources...</span>
            </div>
          )}

          {/* Provider-specific config */}
          {!loadingResources && selectedConnection && renderProviderConfig()}

          {/* Test Result */}
          {testResult && (
            <div className={`p-3 rounded-lg ${testResult.success ? "bg-emerald-50" : "bg-red-50"}`}>
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-600" />
                )}
                <span className={`text-sm font-medium ${testResult.success ? "text-emerald-700" : "text-red-700"}`}>
                  {testResult.success ? "Connection successful" : "Connection failed"}
                </span>
              </div>
              {testResult.preview?.summary && (
                <p className="text-sm text-emerald-600 mt-1">{testResult.preview.summary}</p>
              )}
              {testResult.error && (
                <p className="text-sm text-red-600 mt-1">{testResult.error}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between">
          <div>
            {isEditing && (
              <Button variant="ghost" size="sm" onClick={handleDeleteClick} className="text-red-600 hover:text-red-700 hover:bg-red-50">
                <Trash2 className="h-4 w-4 mr-1" />
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {isEditing ? (
              <>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing || !isConfigValid()}
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <TestTube2 className="h-4 w-4 mr-1" />}
                  Test
                </Button>
                <Button onClick={handleSave} disabled={saving || !isConfigValid()}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Save
                </Button>
              </>
            ) : (
              <Button onClick={handleTest} disabled={!selectedConnection || testing || !isConfigValid()}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Add & Test
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
