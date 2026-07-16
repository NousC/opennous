/**
 * CRM Integration Types
 * Types for CRM (Pipedrive, HubSpot, ClickUp) integration in the AI Writer chat
 * Note: This is ONLY for proposal generator AI context - workflow modules have full capabilities
 */

// Supported CRM providers
export type CrmProvider = 'pipedrive' | 'hubspot' | 'clickup' | 'attio';

// Type of CRM record
export type CrmRecordType = 'deal' | 'contact' | 'lead' | 'company' | 'task';

// A CRM connection (from workflow_provider_connections)
export interface CrmConnection {
  id: string;
  provider: CrmProvider;
  providerName: string;
  isVerified: boolean;
  lastTestAt?: string;
  // ClickUp-specific: which list contains leads (for proposal generator only)
  clickupListId?: string;
  clickupListName?: string;
}

// ClickUp list for selection
export interface ClickUpList {
  id: string;
  name: string;
  folderId?: string;
  folderName?: string;
  spaceId?: string;
  spaceName?: string;
}

// A normalized CRM record (deal, contact, or lead)
export interface CrmRecord {
  id: string;
  type: CrmRecordType;
  provider: CrmProvider;

  // Common fields
  name: string;
  email?: string;
  phone?: string;
  company?: string;

  // Deal-specific fields
  dealValue?: number;
  dealCurrency?: string;
  dealStatus?: 'open' | 'won' | 'lost';
  dealStage?: string;
  expectedCloseDate?: string;

  // Contact-specific fields
  firstName?: string;
  lastName?: string;
  jobTitle?: string;

  // Lead-specific fields
  source?: string;

  // Additional notes/description
  notes?: string;

  // Organization/Company fields
  organizationName?: string;

  // Metadata
  createdAt?: string;
  updatedAt?: string;
  ownerName?: string;
}

// Selected CRM record for chat context
export interface SelectedCrmRecord extends CrmRecord {
  connectionId: string;
}

// CRM context passed to the chat endpoint
export interface CrmChatContext {
  provider: CrmProvider;
  connectionId: string;
  records: SelectedCrmRecord[];
}

// API response for fetching CRM records
export interface CrmRecordsResponse {
  success: boolean;
  provider: CrmProvider;
  recordType: CrmRecordType;
  records: CrmRecord[];
  total: number;
  error?: string;
}

// API response for fetching CRM connections
export interface CrmConnectionsResponse {
  success: boolean;
  connections: CrmConnection[];
  error?: string;
}
