import { Shield } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./SettingsKit";

// Settings › Security in the credential-free preview. The real panel is the auth provider's own
// (contexts/auth/select.tsx → AccountSecurity, GET-577), so nothing here may import Clerk.

const icoCls = "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-ink-2 [&_svg]:h-4 [&_svg]:w-4";

/** In the credential-free preview there is no Clerk to ask. */
export function SecurityPreview() {
  return (
    <SettingsGroup title="Sign-in">
      <SettingsRow label="Sign-in method" hint="Managed by Clerk, which the preview runs without" leading={<span className={icoCls}><Shield /></span>} />
    </SettingsGroup>
  );
}
