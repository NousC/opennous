// Props for the auth UI slots that differ per provider (GET-577). The pages own
// layout and routing; a slot only renders the provider's credential UI.
export type SignInFormProps = { redirectTo: string; redirectQuery: string };
export type SignUpFormProps = {
  afterAuth: string;
  redirectQuery: string;
  // Self-host set-up only (Supabase Auth): the first account presents the setup token.
  setupRequired?: boolean;
  setupToken?: string;
};
export type InviteSignUpProps = { email: string; invitePath: string };
export type AccountSecurityProps = { theme: string };
