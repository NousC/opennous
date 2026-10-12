import { BOX_SHADOW } from "@/lib/authTheme";
import type { InviteSignUpProps } from "@/contexts/auth/slotTypes";
import { SignUpFields } from "./SignUpFields";

// Account creation for an invitee, locked to the invited email. Existing users
// sign in through /login and come back to the invite.
export default function SupabaseInviteSignUp({ email, invitePath }: InviteSignUpProps) {
  return (
    <div className="w-full overflow-hidden rounded-lg border border-[#ECEAE4] bg-white px-5 pb-5 pt-1" style={BOX_SHADOW}>
      <SignUpFields
        fixedEmail={email}
        afterAuth={invitePath}
        signInHref={`/login?redirect=${encodeURIComponent(invitePath)}`}
      />
    </div>
  );
}
