interface LinkedInChannel {
  state?: string | null;
  invited_at?: string | null;
  messages_sent?: number;
  messages_received?: number;
  awaiting_reply?: boolean;
  last_message_at?: string | null;
  chat_id?: string | null;
}

// If an invite was sent >14 days ago and hasn't been accepted, mark it expired.
export function computeLinkedInChannel(li: LinkedInChannel): LinkedInChannel {
  if (!li || li.state !== 'invite_sent' || !li.invited_at) return li;
  const expired = Date.now() - new Date(li.invited_at).getTime() > 14 * 86400000;
  return expired ? { ...li, state: 'expired' } : li;
}
