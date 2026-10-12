// Where "Contact us" goes, everywhere in the app (GET-761). Cloud's own booking link comes from
// the Workspace layer (cloud/config/contact.ts, via the registry); a self-hosted build uses
// VITE_CONTACT_URL, else the project's site.
import { cloud } from "@/lib/cloud";

export const CONTACT_URL: string = cloud.contactUrl || import.meta.env.VITE_CONTACT_URL || "https://opennous.cloud";
