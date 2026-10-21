// Slack text with its @mentions as names (GET-976).
//
// Slack writes a mention as `<@U0123ABC>`. The original text is evidence and is never rewritten;
// the names are display metadata beside it. A row that carries its own (`raw.slack_mentions`,
// stamped when the message was read) uses that first, and every other surface (a quote on an
// Intel fact, a next step, a deal's conversation preview) falls back to the workspace's resolved
// Slack members. A member nobody resolved reads "@Slack member", never a guessed person, and only
// a resolved customer links to their Person record.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export type SlackMentions = Record<string, { name?: string | null; personId?: string | null }>;

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const TOKEN = /(<@[UW][A-Z0-9]+(?:\|[^>]*)?>)/g;
const ONE = /^<@([UW][A-Z0-9]+)(?:\|([^>]*))?>$/;

export const hasSlackMention = (text: unknown): boolean => typeof text === "string" && /<@[UW][A-Z0-9]+/.test(text);

/** The workspace's resolved Slack members, fetched once and shared, only when a mention is on screen. */
export function useSlackMembers(enabled = true): SlackMentions {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const { data } = useQuery<SlackMentions>({
    queryKey: ["slack-members", workspaceId],
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/slack/channels/members?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } });
      // Self-host has no Slack reading: no names, and the text still reads.
      if (!r.ok) return {};
      return (await r.json()).members ?? {};
    },
    enabled: enabled && !!token && !!workspaceId,
    staleTime: 5 * 60_000,
  });
  return data ?? {};
}

/** The text as plain words: each mention as @Name, for places that cannot hold a link. */
export function slackPlainText(text: string, mentions: SlackMentions = {}): string {
  return text.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${mentions[id]?.name || label || "Slack member"}`);
}

/** Slack text with mentions drawn as names; a resolved customer links to their Person. */
export function SlackText({ text, mentions }: { text: string; mentions?: SlackMentions | null }): ReactNode {
  const tagged = hasSlackMention(text);
  const members = useSlackMembers(tagged);
  if (!tagged) return text;
  const names: SlackMentions = { ...members, ...(mentions ?? {}) };
  return <>{text.split(TOKEN).map((part, index) => {
    const match = ONE.exec(part);
    if (!match) return part;
    const person = names[match[1]];
    const label = `@${person?.name || match[2] || "Slack member"}`;
    return person?.personId && /^[0-9a-f-]{36}$/i.test(person.personId)
      ? <Link key={index} to={`/people/${person.personId}`} className="text-foreground hover:underline" onClick={e => e.stopPropagation()}>{label}</Link>
      : <span key={index}>{label}</span>;
  })}</>;
}
