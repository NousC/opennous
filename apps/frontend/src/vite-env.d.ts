/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_PROVIDER?: string;
  /** "false" turns off Google favicons and Gravatar photos (lib/externalImages.ts). */
  readonly VITE_EXTERNAL_IMAGES?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Where "Contact us" links go on a self-hosted build (config/contact.ts). */
  readonly VITE_CONTACT_URL?: string;
}
