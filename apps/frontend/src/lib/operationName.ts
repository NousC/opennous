export type OpColor = "green" | "blue" | "sky" | "violet" | "orange" | "teal" | "yellow" | "emerald" | "purple" | "pink" | "gray";

export interface OpInfo {
  name: string;
  color: OpColor;
}

// Color hex values for inline styles (Tailwind purge-safe)
export const OP_COLORS: Record<OpColor, string> = {
  green:   "#4ade80",
  blue:    "#60a5fa",
  sky:     "#38bdf8",
  violet:  "#a78bfa",
  orange:  "#fb923c",
  teal:    "#2dd4bf",
  yellow:  "#facc15",
  emerald: "#34d399",
  purple:  "#c084fc",
  pink:    "#f472b6",
  gray:    "#9ca3af",
};

// Maps source + event_type from workspace_system_log → dot.notation op name
export function systemLogOpName(
  source: string,
  eventType: string,
  metadata?: Record<string, unknown>
): OpInfo {
  const s = (source ?? "").toLowerCase();
  const e = (eventType ?? "").toLowerCase();

  if (s === "linkedin") {
    if (e === "scan_complete")   return { name: "linkedin.scan.complete",               color: "blue" };
    if (e === "webhook_received") {
      const t = ((metadata?.type ?? metadata?.event_type ?? "") as string).toLowerCase();
      if (t === "message_sent")   return { name: "linkedin.webhook.message.sent",       color: "blue" };
      if (t.includes("message"))  return { name: "linkedin.webhook.ingest.message",     color: "blue" };
      if (t.includes("connection")) return { name: "linkedin.webhook.ingest.connection", color: "blue" };
      if (t.includes("reply"))    return { name: "linkedin.webhook.reply",               color: "blue" };
      return { name: "linkedin.webhook.ingest", color: "blue" };
    }
    if (e === "signal_ingested") return { name: "linkedin.signal.ingest", color: "blue" };
    if (e === "sync_run")        return { name: "linkedin.sync.run",      color: "blue" };
  }

  if (s === "gmail" || s === "smtp") {
    if (e === "scan_complete")   return { name: s === "smtp" ? "smtp.scan.complete" : "gmail.scan.complete", color: "sky" };
    if (e === "sync_run")        return { name: "gmail.sync.run",         color: "sky" };
    if (e === "signal_ingested") return { name: "gmail.signal.ingest",    color: "sky" };
    if (e === "webhook_received") return { name: "gmail.webhook.ingest",  color: "sky" };
  }

  if (s === "rb2b") {
    if (e === "webhook_received") return { name: "rb2b.webhook.ingest", color: "yellow" };
    return { name: "rb2b.signal.ingest", color: "yellow" };
  }
  if (s === "signalbase") return { name: "signalbase.signal.ingest", color: "yellow"  };
  if (s === "apollo")     return { name: "apollo.enrich.run",        color: "orange"  };
  if (s === "prospeo")    return { name: "prospeo.enrich.run",       color: "orange"  };

  if (s === "stripe") {
    if (e === "webhook_received") return { name: "stripe.webhook.payment", color: "violet" };
    return { name: "stripe.sync.run", color: "violet" };
  }

  if (s === "calendly") {
    if (e === "webhook_received") {
      const t = ((metadata?.type ?? "") as string).toLowerCase();
      if (t.includes("cancel")) return { name: "calendly.webhook.cancelled", color: "emerald" };
      return { name: "calendly.webhook.booked", color: "emerald" };
    }
    return { name: "calendly.sync.run", color: "emerald" };
  }

  if (s === "cal_com") {
    if (e === "webhook_received") {
      const t = ((metadata?.type ?? "") as string).toLowerCase();
      if (t.includes("cancel")) return { name: "cal_com.webhook.cancelled", color: "emerald" };
      return { name: "cal_com.webhook.booked", color: "emerald" };
    }
    return { name: "cal_com.sync.run", color: "emerald" };
  }

  if (s === "fireflies") {
    if (e === "scan_complete")    return { name: "fireflies.scan.complete", color: "purple" };
    if (e === "webhook_received") return { name: "fireflies.webhook.transcript", color: "purple" };
    return { name: "fireflies.sync.run", color: "purple" };
  }

  if (s === "fathom") {
    if (e === "scan_complete")    return { name: "fathom.scan.complete", color: "teal" };
    if (e === "webhook_received") return { name: "fathom.webhook.recording", color: "teal" };
    return { name: "fathom.sync.run", color: "teal" };
  }

  if (s === "instantly") {
    if (e === "scan_complete")    return { name: "instantly.scan.complete",   color: "pink" };
    if (e === "webhook_received") return { name: "instantly.webhook.ingest",  color: "pink" };
    return { name: "instantly.sync.run", color: "pink" };
  }

  if (s === "slack") {
    if (e === "scan_complete")    return { name: "slack.scan.complete",       color: "yellow" };
    if (e === "webhook_received") return { name: "slack.webhook.ingest",      color: "yellow" };
    return { name: "slack.sync.run", color: "yellow" };
  }

  if (s === "mcp" || s === "sdk" || s === "api") {
    if (e === "contact_read")           return { name: "agent.contact.read",      color: "green" };
    if (e === "contact_list")           return { name: "agent.contact.list",      color: "green" };
    if (e === "contact_create")         return { name: "agent.contact.create",    color: "green" };
    if (e === "contact_update")         return { name: "agent.contact.update",    color: "green" };
    if (e === "contact_delete")         return { name: "agent.contact.delete",    color: "green" };
    if (e === "memory_search")          return { name: "agent.context.query",     color: "green" };
    if (e === "memory_write")           return { name: "agent.memory.write",      color: "green" };
    if (e === "activity_track")         return { name: "agent.activity.track",    color: "green" };
    if (e === "workspace_memory_read")  return { name: "agent.workspace.read",    color: "green" };
    if (e === "company_read")           return { name: "agent.company.read",      color: "green" };
    return { name: `agent.${e.replace(/_/g, ".")}`, color: "green" };
  }

  if (s === "import") return { name: "contact.import.run", color: "teal" };
  if (s === "pipeline") return { name: "pipeline.stage.transition", color: "orange" };

  // CRM ops — same provider used by inbound webhooks and outbound push/sync
  if (s === "hubspot" || s === "pipedrive" || s === "attio" || s === "salesforce") {
    const color: OpColor = s === "hubspot" ? "orange" : s === "pipedrive" ? "emerald" : s === "attio" ? "violet" : "sky";
    if (e === "activity_pushed")       return { name: `${s}.activity.pushed`,   color };
    if (e === "activity_push_failed")  return { name: `${s}.activity.failed`,   color: "pink" };
    if (e === "contact_resolved")      return { name: `${s}.contact.resolved`,  color };
    if (e === "contact_created_in_crm")return { name: `${s}.contact.created`,   color };
    if (e === "creation_skipped")      return { name: `${s}.create.skipped`,    color: "gray" };
    if (e === "identity_failed")       return { name: `${s}.identity.failed`,   color: "pink" };
    if (e === "sync_complete")         return { name: `${s}.sync.complete`,     color };
    if (e === "sync_failed")           return { name: `${s}.sync.failed`,       color: "pink" };
    if (e === "hygiene_complete")      return { name: `${s}.hygiene.run`,       color };
    if (e === "hygiene_failed")        return { name: `${s}.hygiene.failed`,    color: "pink" };
    if (e === "proposal_approved")     return { name: `${s}.proposal.approved`, color: "green" };
    if (e === "proposal_dismissed")    return { name: `${s}.proposal.dismissed`, color: "gray" };
    if (e === "proposal_applied")      return { name: `${s}.proposal.applied`,  color };
    if (e === "proposal_apply_failed") return { name: `${s}.proposal.failed`,   color: "pink" };
    if (e === "webhook_received")      return { name: `${s}.webhook.ingest`,    color };
  }

  if (s === "memory" || s === "system") {
    if (e === "enrichment_run")      return { name: "identity.enrich.run",      color: "violet" };
    if (e === "icp_scored")          return { name: "identity.icp.score",        color: "violet" };
    if (e === "stage_transition")    return { name: "pipeline.stage.transition", color: "orange" };
    if (e === "extraction_complete") return { name: "identity.extract.complete", color: "violet" };
    if (e === "sync_run")            return { name: "identity.sync.run",         color: "violet" };
  }

  // Fallback: build a readable name from source + event_type
  return {
    name:  `${s}.${e.replace(/_/g, ".")}`,
    color: "gray",
  };
}

// Maps op_type + entity_type → dot.notation op name
export function agentOpName(opType: string, entityType: string): OpInfo {
  const op     = (opType    ?? "").toLowerCase();
  const entity = (entityType ?? "").toLowerCase();

  if (op === "write") {
    if (entity === "memory")         return { name: "agent.memory.write",   color: "green" };
    if (entity === "activity")       return { name: "agent.activity.track", color: "green" };
    if (entity === "contact_create") return { name: "agent.contact.create", color: "green" };
    if (entity === "contact_update") return { name: "agent.contact.update", color: "green" };
    return { name: `agent.${entity.replace(/_/g, ".")}.write`, color: "green" };
  }

  if (op === "delete") {
    if (entity === "memory")  return { name: "agent.memory.delete",  color: "green" };
    if (entity === "contact") return { name: "agent.contact.delete", color: "green" };
    return { name: `agent.${entity.replace(/_/g, ".")}.delete`, color: "green" };
  }

  // retrieve
  if (entity === "contact")      return { name: "agent.contact.read",   color: "green" };
  if (entity === "contact_list") return { name: "agent.contact.list",   color: "green" };
  if (entity === "company")      return { name: "agent.company.read",   color: "green" };
  if (entity === "search")       return { name: "agent.context.query",  color: "green" };
  if (entity === "memory")       return { name: "agent.memory.read",    color: "green" };

  return { name: `agent.${entity.replace(/_/g, ".")}.read`, color: "green" };
}
