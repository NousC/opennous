import { useAuth } from "@/contexts/AuthContext";

export interface Terminology {
  /** Singular label for a person who buys from you. Reflects workspace.business_type. */
  buyer: string;
  /** Plural form */
  buyers: string;
  /** Label used for brand-new signups (e.g. "Free User", "Trial", "Lead"). Workspace-configurable. */
  signupStage: string;
  /** Universal post-conversion stage label */
  paidStage: string;
}

const DEFAULTS: Terminology = {
  buyer: "Customer",
  buyers: "Customers",
  signupStage: "Free User",
  paidStage: "Customer",
};

/**
 * Resolves UI labels for buyer-facing terminology based on the active workspace.
 * Falls back to "Customer" if the workspace hasn't picked a business_type yet.
 */
export function useTerminology(): Terminology {
  const { userData } = useAuth();
  const w = userData?.workspace;
  if (!w) return DEFAULTS;

  const isService = w.business_type === "service";
  return {
    buyer: isService ? "Client" : "Customer",
    buyers: isService ? "Clients" : "Customers",
    signupStage: (w.default_signup_stage as string)?.trim() || (isService ? "Lead" : "Free User"),
    paidStage: "Customer",
  };
}
