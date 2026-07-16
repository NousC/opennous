import { FileText, Zap, BarChart3, Calendar, Database, Box, Workflow, Users, Shield } from "lucide-react";

export interface Integration {
  id: string;
  name: string;
  slug: string;
  logo: string;
  category: string;
  description: string;
  longDescription: string;
  keyBenefits: string[];
  useCases: { title: string; description: string }[];
  setupSteps: { title: string; description: string; image?: string }[];
  apiDocLink?: string;
  faqs: { question: string; answer: string }[];
}

export const CATEGORIES = [
  "Sales & CRM",
  "Email",
  "Payments",
  "Productivity"
];

export const INTEGRATIONS: Integration[] = [
  {
    id: "pipedrive",
    name: "Pipedrive",
    slug: "pipedrive",
    logo: "https://www.google.com/s2/favicons?domain=pipedrive.com&sz=128",
    category: "Sales & CRM",
    description: "Connect Pipedrive to automatically generate documents when deals progress through your pipeline.",
    longDescription: "Pipedrive is the sales-first CRM built by salespeople for salespeople. By integrating Pipedrive with Nous, you can automatically generate proposals, contracts, and NDAs when deals move to specific stages, saving hours of manual document creation.",
    keyBenefits: [
      "Auto-generate proposals when deals reach specific stages",
      "Personalize documents with Pipedrive contact and deal data",
      "Attach generated documents directly to deals"
    ],
    useCases: [
      {
        title: "Automatic Proposal Generation",
        description: "Generate personalized proposals automatically when a deal moves to the 'Proposal' stage."
      },
      {
        title: "Contract Automation",
        description: "Create contracts pre-filled with deal values and contact information when deals are won."
      },
      {
        title: "NDA Generation",
        description: "Automatically send NDAs to new contacts added to your pipeline."
      }
    ],
    setupSteps: [
      {
        title: "Connect Pipedrive",
        description: "Authorize Nous to access your Pipedrive account through our secure OAuth connection."
      },
      {
        title: "Select Trigger Stage",
        description: "Choose which pipeline stage should trigger document generation."
      },
      {
        title: "Map Fields",
        description: "Map Pipedrive contact and deal fields to your document template variables."
      },
      {
        title: "Activate Workflow",
        description: "Enable the workflow and documents will be generated automatically."
      }
    ],
    faqs: [
      {
        question: "How does Nous connect to Pipedrive?",
        answer: "Nous connects to Pipedrive through a secure OAuth integration. Simply click 'Connect' and authorize Nous to access your Pipedrive data."
      },
      {
        question: "Can I use custom fields from Pipedrive?",
        answer: "Yes, all your custom fields from Pipedrive are available to use as variables in your document templates."
      },
      {
        question: "Which Pipedrive pipeline stages can trigger document generation?",
        answer: "Any stage in any of your Pipedrive pipelines can be used as a trigger. You can set up multiple triggers across different pipelines — for example, generate a proposal when a deal enters 'Negotiation' and a contract when it moves to 'Won'."
      },
      {
        question: "Can I attach generated documents back to the Pipedrive deal?",
        answer: "Yes, Nous automatically attaches the generated PDF to the corresponding deal in Pipedrive as a file. Your sales team can find the document directly in the deal's Files tab without leaving Pipedrive."
      },
      {
        question: "Does Nous support multiple Pipedrive pipelines?",
        answer: "Absolutely. You can create separate automation workflows for each pipeline. This is useful if you have different document templates for different sales processes — for instance, one pipeline for new business proposals and another for renewal contracts."
      },
      {
        question: "Is my Pipedrive data secure with Nous?",
        answer: "Yes, security is a top priority. Nous uses OAuth 2.0 for authentication so your Pipedrive credentials are never stored. All data is encrypted in transit and at rest, and we only access the specific deal and contact data needed to generate your documents."
      }
    ]
  },
  {
    id: "hubspot",
    name: "HubSpot",
    slug: "hubspot",
    logo: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=128",
    category: "Sales & CRM",
    description: "Automatically generate proposals, contracts, and reports when deals move through your HubSpot pipeline.",
    longDescription: "HubSpot is the leading all-in-one CRM platform for scaling businesses. By integrating HubSpot with Nous, you can automatically generate personalized proposals, contracts, onboarding documents, and reports whenever deals progress through your pipeline stages — eliminating manual document creation and accelerating your sales cycle.",
    keyBenefits: [
      "Auto-generate documents when deals change stages",
      "Pull contact, company, and deal properties into templates",
      "Attach generated PDFs directly to HubSpot deal records"
    ],
    useCases: [
      {
        title: "Proposal Automation",
        description: "Generate branded proposals automatically when a deal enters the 'Proposal Sent' stage in your HubSpot pipeline."
      },
      {
        title: "Onboarding Documents",
        description: "Create personalized onboarding packets pre-filled with company and contact data when deals close."
      },
      {
        title: "Quarterly Business Reviews",
        description: "Auto-generate QBR documents pulling deal history and engagement data from HubSpot."
      }
    ],
    setupSteps: [
      {
        title: "Connect HubSpot",
        description: "Authorize Nous to access your HubSpot account through a secure OAuth connection."
      },
      {
        title: "Select Pipeline & Stage",
        description: "Choose which pipeline and deal stage should trigger document generation."
      },
      {
        title: "Map Properties",
        description: "Map HubSpot contact, company, and deal properties to your document template variables."
      },
      {
        title: "Activate Workflow",
        description: "Enable the automation and documents will be generated every time a deal hits your trigger stage."
      }
    ],
    faqs: [
      {
        question: "How does Nous connect to HubSpot?",
        answer: "Nous connects to HubSpot via a secure OAuth 2.0 integration. Click 'Connect', authorize access, and Nous will be able to read your deal, contact, and company data to populate document templates."
      },
      {
        question: "Can I use HubSpot custom properties in my documents?",
        answer: "Yes, all standard and custom properties from contacts, companies, and deals are available as template variables in Nous."
      },
      {
        question: "Does it work with multiple HubSpot pipelines?",
        answer: "Absolutely. You can set up separate automations for each pipeline — for example, one for new business proposals and another for renewal contracts."
      },
      {
        question: "Can generated documents be attached back to HubSpot?",
        answer: "Yes, Nous automatically attaches the generated PDF to the corresponding deal record in HubSpot so your team can access it without leaving the CRM."
      }
    ]
  },
  {
    id: "attio",
    name: "Attio",
    slug: "attio",
    logo: "https://www.google.com/s2/favicons?domain=attio.com&sz=128",
    category: "Sales & CRM",
    description: "Generate documents automatically from Attio records when deals progress through your pipeline.",
    longDescription: "Attio is the next-generation CRM built for modern teams who need flexibility and powerful data modeling. Integrating Attio with Nous lets you automatically generate proposals, contracts, and reports based on your Attio records and pipeline stages — turning your CRM data into polished documents without lifting a finger.",
    keyBenefits: [
      "Trigger document generation from Attio pipeline stage changes",
      "Pull data from any Attio object or attribute into templates",
      "Keep your team focused on selling, not creating documents"
    ],
    useCases: [
      {
        title: "Deal-Stage Proposals",
        description: "Automatically generate a personalized proposal when a deal moves to your 'Proposal' stage in Attio."
      },
      {
        title: "Client Onboarding Packs",
        description: "Create onboarding documents pre-filled with company data the moment a deal is marked as won."
      },
      {
        title: "Partnership Agreements",
        description: "Generate partnership agreements pulling contact and company attributes directly from Attio records."
      }
    ],
    setupSteps: [
      {
        title: "Connect Attio",
        description: "Authorize Nous to access your Attio workspace through a secure API connection."
      },
      {
        title: "Choose Pipeline Trigger",
        description: "Select which pipeline and stage should trigger document generation."
      },
      {
        title: "Map Attributes",
        description: "Map Attio record attributes to your document template variables."
      },
      {
        title: "Go Live",
        description: "Activate the workflow and documents will be generated automatically as deals progress."
      }
    ],
    faqs: [
      {
        question: "How does Nous integrate with Attio?",
        answer: "Nous connects to Attio via a secure API integration. Once connected, Nous can read your records, objects, and pipeline data to dynamically populate document templates."
      },
      {
        question: "Can I use custom Attio attributes in documents?",
        answer: "Yes, all standard and custom attributes from any Attio object are available as template variables in Nous."
      },
      {
        question: "Does it support Attio's flexible data model?",
        answer: "Yes. Nous adapts to however you've structured your Attio workspace — whether you use custom objects, lists, or relationship attributes, they're all available for document generation."
      },
      {
        question: "Is my Attio data secure?",
        answer: "Absolutely. Nous uses secure API authentication, encrypts all data in transit and at rest, and only accesses the specific record data needed to generate your documents."
      }
    ]
  },
  {
    id: "fireflies",
    name: "Fireflies.ai",
    slug: "fireflies",
    logo: "https://www.google.com/s2/favicons?domain=fireflies.ai&sz=128",
    category: "Productivity",
    description: "Turn discovery call transcripts from Fireflies.ai into personalized sales proposals automatically.",
    longDescription: "Fireflies.ai is an AI meeting assistant that records, transcribes, and summarizes your meetings. By integrating Fireflies with Nous, you can automatically turn discovery call transcripts into polished, personalized sales proposals — extracting key requirements, pain points, and budget from the conversation and generating a ready-to-send proposal without any manual work.",
    keyBenefits: [
      "Turn discovery calls into proposals in minutes, not hours",
      "Extract client requirements and pain points automatically",
      "Send personalized proposals while the conversation is still fresh"
    ],
    useCases: [
      {
        title: "Discovery Call to Proposal",
        description: "Automatically generate a personalized sales proposal from your discovery call transcript — extracting requirements, pain points, and budget to pre-fill your template."
      },
      {
        title: "Follow-Up with Context",
        description: "Send prospects a branded proposal that references exactly what was discussed on the call, showing you listened and understood their needs."
      },
      {
        title: "Faster Sales Cycles",
        description: "Eliminate the hours spent manually writing proposals after calls. Have a polished document ready to send within minutes of hanging up."
      }
    ],
    setupSteps: [
      {
        title: "Connect Fireflies.ai",
        description: "Authorize Nous to access your Fireflies.ai account and meeting data."
      },
      {
        title: "Select Meeting Triggers",
        description: "Choose which meeting types or channels should trigger document generation."
      },
      {
        title: "Map Meeting Data",
        description: "Map transcript fields, action items, and attendee data to your document template variables."
      },
      {
        title: "Activate Automation",
        description: "Enable the workflow and documents will be generated after each qualifying meeting."
      }
    ],
    faqs: [
      {
        question: "How does Nous connect to Fireflies.ai?",
        answer: "Nous connects to Fireflies.ai through a secure API integration. Once connected, Nous can access your meeting transcripts, summaries, and action items to populate document templates."
      },
      {
        question: "Can I choose which meetings trigger document generation?",
        answer: "Yes, you can filter by meeting channel, participants, keywords, or other criteria so only relevant meetings generate documents."
      },
      {
        question: "What meeting data can I use in documents?",
        answer: "You can use the full transcript, AI-generated summary, action items, attendee names, meeting duration, date, and any custom fields from Fireflies."
      },
      {
        question: "Can I turn a sales call into a proposal automatically?",
        answer: "Yes — set up a workflow that triggers on sales call recordings, extracts key requirements and client details from the transcript, and generates a personalized proposal using your Nous template."
      }
    ]
  },
  {
    id: "fathom",
    name: "Fathom",
    slug: "fathom",
    logo: "https://www.google.com/s2/favicons?domain=fathom.video&sz=128",
    category: "Productivity",
    description: "Pull meeting transcripts, summaries, and action items from Fathom into your AI chat and proposals.",
    longDescription: "Fathom is an AI meeting assistant that records, transcribes, and summarizes your video calls. By integrating Fathom with Nous, your AI chat can automatically search through past meetings to pull in context — extracting key requirements, decisions, and action items to generate proposals and documents grounded in what was actually discussed.",
    keyBenefits: [
      "Search meeting transcripts directly from AI chat",
      "Pull client requirements and decisions into proposals automatically",
      "Access summaries and action items from any recorded call"
    ],
    useCases: [
      {
        title: "Discovery Call to Proposal",
        description: "Ask the AI chat about a recent discovery call and it will pull the transcript to generate a personalized proposal based on what was discussed."
      },
      {
        title: "Meeting Context in Chat",
        description: "Reference any past meeting in the AI chat and Fathom will surface the transcript, summary, and action items for context."
      },
      {
        title: "Automated Follow-Ups",
        description: "Use Fathom webhooks to trigger document generation when a meeting recording is ready — sending follow-up proposals or summaries automatically."
      }
    ],
    setupSteps: [
      {
        title: "Get Your API Key",
        description: "Go to your Fathom account settings and generate an API key under the API section."
      },
      {
        title: "Connect Fathom",
        description: "In Nous, go to Settings > Integrations and add your Fathom API key."
      },
      {
        title: "Use in Chat",
        description: "Open any AI chat and reference a meeting — Fathom will be searched automatically for relevant transcripts and summaries."
      },
      {
        title: "Set Up Webhooks (Optional)",
        description: "Configure a Fathom webhook to notify Nous when new meeting content is ready, enabling automatic document generation."
      }
    ],
    faqs: [
      {
        question: "How does Nous connect to Fathom?",
        answer: "Nous connects to Fathom through a secure API key integration. Enter your Fathom API key in Settings > Integrations, and Nous will be able to search your meeting recordings, transcripts, and summaries."
      },
      {
        question: "What meeting data can I access through the integration?",
        answer: "You can access meeting titles, transcripts, AI-generated summaries, action items, attendee lists, recording timestamps, and calendar invitee information from all your Fathom recordings."
      },
      {
        question: "Does the AI chat automatically search Fathom?",
        answer: "Yes. When you mention a client name, company, or reference a past meeting in the AI chat, it will proactively search your Fathom recordings for relevant context — you don't need to ask it to search."
      },
      {
        question: "Can I trigger document generation from Fathom webhooks?",
        answer: "Yes. Fathom can send a webhook when new meeting content is ready. You can configure this to automatically trigger proposal or document generation in Nous based on the meeting data."
      }
    ]
  },
  {
    id: "stripe",
    name: "Stripe",
    slug: "stripe",
    logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=128",
    category: "Payments",
    description: "Generate invoices, receipts, and financial documents automatically when payments are processed.",
    longDescription: "Stripe is the leading payment processing platform for internet businesses. Integrate Stripe with Nous to automatically generate professional invoices, receipts, and financial reports when payments are processed, subscriptions are created, or billing events occur.",
    keyBenefits: [
      "Auto-generate invoices when payments are received",
      "Create branded receipts for successful transactions",
      "Generate subscription summaries and reports"
    ],
    useCases: [
      {
        title: "Automatic Invoice Generation",
        description: "Generate and send professional invoices when Stripe payments are successful."
      },
      {
        title: "Receipt Creation",
        description: "Create branded receipts automatically for all successful transactions."
      },
      {
        title: "Subscription Reports",
        description: "Generate monthly subscription summaries for your finance team."
      }
    ],
    setupSteps: [
      {
        title: "Connect Stripe",
        description: "Authorize Nous to receive webhooks from your Stripe account."
      },
      {
        title: "Select Events",
        description: "Choose which Stripe events should trigger document generation."
      },
      {
        title: "Design Template",
        description: "Create your invoice or receipt template with Stripe data variables."
      },
      {
        title: "Enable Automation",
        description: "Activate the workflow to start generating documents automatically."
      }
    ],
    faqs: [
      {
        question: "What Stripe events can trigger document generation?",
        answer: "You can trigger documents on payment success, subscription created, invoice finalized, and many other Stripe webhook events."
      },
      {
        question: "Can I include line items from Stripe in my documents?",
        answer: "Yes, all Stripe data including line items, customer details, and payment information can be used in your document templates."
      }
    ]
  },
  {
    id: "slack",
    name: "Slack",
    slug: "slack",
    logo: "https://www.google.com/s2/favicons?domain=slack.com&sz=128",
    category: "Productivity",
    description: "Send generated documents to Slack channels and receive notifications when documents are signed.",
    longDescription: "Slack is the leading business communication platform. Integrate Slack with Nous to automatically share generated documents in channels, receive notifications when documents are signed, and keep your team informed about document workflows.",
    keyBenefits: [
      "Share generated documents directly to Slack channels",
      "Get notified when documents are viewed or signed",
      "Keep your team in sync with document workflows"
    ],
    useCases: [
      {
        title: "Document Sharing",
        description: "Automatically post generated proposals to your sales channel for team review."
      },
      {
        title: "Signature Notifications",
        description: "Get instant Slack notifications when clients sign documents."
      },
      {
        title: "Workflow Updates",
        description: "Keep stakeholders informed with automatic status updates in relevant channels."
      }
    ],
    setupSteps: [
      {
        title: "Connect Slack",
        description: "Authorize Nous to post messages to your Slack workspace."
      },
      {
        title: "Select Channels",
        description: "Choose which channels should receive document notifications."
      },
      {
        title: "Configure Notifications",
        description: "Set up which events trigger Slack messages."
      },
      {
        title: "Customize Messages",
        description: "Personalize the message format and content."
      }
    ],
    faqs: [
      {
        question: "Can I send documents to private channels?",
        answer: "Yes, you can send documents to any channel that Nous has been invited to, including private channels."
      },
      {
        question: "What notifications can I receive in Slack?",
        answer: "You can receive notifications for document generation, document viewed, document signed, and workflow completions."
      }
    ]
  },
  {
    id: "clickup",
    name: "ClickUp",
    slug: "clickup",
    logo: "https://www.google.com/s2/favicons?domain=clickup.com&sz=128",
    category: "Productivity",
    description: "Generate documents from ClickUp tasks and attach them automatically to your projects.",
    longDescription: "ClickUp is the all-in-one productivity platform. Connect ClickUp with Nous to automatically generate documents when tasks reach certain statuses, attach generated files to tasks, and streamline your project documentation workflows.",
    keyBenefits: [
      "Generate documents from task data automatically",
      "Attach documents directly to ClickUp tasks",
      "Trigger workflows based on task status changes"
    ],
    useCases: [
      {
        title: "Project Documentation",
        description: "Automatically generate project briefs when new projects are created in ClickUp."
      },
      {
        title: "Client Deliverables",
        description: "Create and attach client deliverables when tasks are marked complete."
      },
      {
        title: "Status Reports",
        description: "Generate weekly status reports from task data automatically."
      }
    ],
    setupSteps: [
      {
        title: "Connect ClickUp",
        description: "Authorize Nous to access your ClickUp workspace."
      },
      {
        title: "Select Workspace",
        description: "Choose which workspace and lists to connect."
      },
      {
        title: "Set Triggers",
        description: "Define which task events should generate documents."
      },
      {
        title: "Map Task Fields",
        description: "Map ClickUp custom fields to your document template variables."
      }
    ],
    faqs: [
      {
        question: "Can I use ClickUp custom fields in documents?",
        answer: "Yes, all your ClickUp custom fields are available as variables in your document templates."
      },
      {
        question: "Which ClickUp events can trigger document generation?",
        answer: "Documents can be triggered on task creation, status change, assignee change, and custom field updates."
      }
    ]
  },
  {
    id: "outlook_oauth",
    name: "Microsoft Outlook",
    slug: "outlook",
    logo: "https://www.google.com/s2/favicons?domain=outlook.com&sz=128",
    category: "Email",
    description: "Connect Outlook to ingest email threads as contact activity signals for GTM agents.",
    longDescription: "Microsoft Outlook is the email platform used by most enterprise GTM teams. By connecting Outlook, Nous reads your email history per contact and surfaces it as structured memory — so agents always know what was said, when, and what the next step should be.",
    keyBenefits: [
      "Auto-log email threads as contact activity signals",
      "Agents read email history before every interaction",
      "Memory compounds across every session — no cold starts"
    ],
    useCases: [
      {
        title: "Pre-call Context",
        description: "An agent pulls Outlook history for a contact before a call — surfaces last topic, any objections raised, and open follow-ups."
      },
      {
        title: "Signal Enrichment",
        description: "Every email thread is logged to contact_activity_log, building a timeline of every touchpoint with each account."
      }
    ],
    setupSteps: [
      {
        title: "Connect via Microsoft OAuth",
        description: "Click Connect and authorize Nous to read your Outlook mail. Uses Microsoft's standard OAuth 2.0 — your credentials are never stored."
      },
      {
        title: "Select contacts to sync",
        description: "Choose which contacts or domains to start syncing email history from."
      },
      {
        title: "Agents get context automatically",
        description: "From this point, any agent call that reads contact memory will include Outlook email signals."
      }
    ],
    apiDocLink: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview",
    faqs: [
      {
        question: "What permissions does Nous request?",
        answer: "We request Mail.Read (read-only) and User.Read. We never send email on your behalf and never modify your mailbox."
      },
      {
        question: "Does this work with Microsoft 365 and Exchange accounts?",
        answer: "Yes — any account backed by Microsoft Graph works, including Microsoft 365, Exchange Online, and Outlook.com personal accounts."
      },
      {
        question: "Is my email data secure?",
        answer: "All tokens are encrypted at rest using AES-256-GCM. We only read the threads associated with contacts already in your Nous workspace."
      }
    ]
  },
];

export const getIntegrationBySlug = (slug: string): Integration | undefined => {
  return INTEGRATIONS.find(i => i.slug === slug);
};

