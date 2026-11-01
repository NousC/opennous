// Where "Contact us" goes, everywhere in the app (GET-761). Cloud's own booking link comes from
// the Workspace layer (cloud/config/contact.ts, via the registry); a self-hosted build uses
// VITE_CONTACT_URL, else the project's site.
//
// A function, read at render. The registry is loaded eagerly and pulls in components that end up
// here, so reading `cloud` while this module loads hits it before it exists and the whole app
// comes up as a blank page (GET-1087).
import { cloud } from "@/lib/cloud";

export const contactUrl = (): string => cloud.contactUrl || import.meta.env.VITE_CONTACT_URL || "https://opennous.cloud";
