import { NousPageLayout, Theme } from "@/components/NousPageLayout";
import { legalEntity, legalAddress } from "@/config/legal";

const S = {
  label: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.accent, textTransform: "uppercase" as const, letterSpacing: "0.18em", marginBottom: "10px" }),
  h1: (t: Theme) => ({ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "clamp(1.8rem,3.5vw,2.4rem)", color: t.text, lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: "12px" }),
  meta: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted }),
  h2: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "13px", fontWeight: 600, color: t.text, marginBottom: "12px", marginTop: "0" }),
  body: (t: Theme) => ({ fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted, lineHeight: 1.75, marginBottom: "12px" }),
  li: (t: Theme) => ({ fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted, lineHeight: 1.7 }),
  link: (t: Theme) => ({ color: t.accent, textDecoration: "underline" as const }),
  divider: (t: Theme) => ({ borderTop: `1px solid ${t.border}`, margin: "40px 0" }),
  section: { marginBottom: "36px" },
};

function Section({ t, title, children }: { t: Theme; title: string; children: React.ReactNode }) {
  return <section style={S.section}><h2 style={S.h2(t)}>{title}</h2>{children}</section>;
}

function Li({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <li style={S.li(t)}>— {children}</li>;
}

export default function TermsOfService() {
  return (
    <NousPageLayout
      seoTitle="Terms of Service | Nous"
      seoDescription="Nous Terms of Service — terms and conditions governing your use of our platform."
    >
      {(t) => (
        <>
          <div style={{ marginBottom: "48px" }}>
            <p style={S.label(t)}># Legal</p>
            <h1 style={S.h1(t)}>Terms of Service</h1>
            <p style={S.meta(t)}>Last updated: April 21, 2026</p>
          </div>

          <Section t={t} title="1. Agreement to Terms">
            <p style={S.body(t)}>These Terms of Service ("Terms") constitute a legally binding agreement between you and Nous governing your access to and use of Nous — the GTM Context API for agents — including opennous.cloud, the MCP server, and related APIs (collectively, the "Service").</p>
            <p style={S.body(t)}>By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, you may not use the Service.</p>
          </Section>

          <Section t={t} title="2. Description of Service">
            <p style={S.body(t)}>Nous is the GTM Context API for agents — a hosted memory and signal layer for AI agents running sales and marketing workflows. The Service enables users to:</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Store and retrieve structured memory about contacts and companies via MCP or REST API","Ingest signals from connected tools (email, LinkedIn, CRM, analytics)","Run AI-powered memory synthesis, enrichment, and research","Expose persistent context to AI agents via the Nous MCP server","Collaborate across workspaces with unlimited team members"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="3. Account Registration">
            <p style={S.body(t)}>To use certain features, you must register for an account. When you register, you agree to:</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "12px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Provide accurate, current, and complete information","Maintain the security of your password and API keys","Accept responsibility for all activities under your account","Notify us immediately of any unauthorized use"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
            <p style={S.body(t)}>You must be at least 18 years old to create an account.</p>
          </Section>

          <Section t={t} title="4. Subscription and Payment">
            <p style={S.body(t)}>The Service is offered through subscription plans billed by operations and records per month. Features and pricing are described on our pricing page and may be updated from time to time.</p>
            <p style={S.body(t)}>Subscriptions are billed in advance on a monthly or annual basis. By subscribing, you authorize us to charge your payment method for the applicable fees.</p>
            <p style={S.body(t)}>Subscription fees are non-refundable except as required by applicable law.</p>
          </Section>

          <Section t={t} title="5. User Content and Data">
            <p style={S.body(t)}>You retain all rights to the contact data, company data, activity logs, and memory entries you create or import through the Service ("User Content"). We do not claim ownership of your User Content.</p>
            <p style={S.body(t)}>By submitting User Content, you grant us a worldwide, non-exclusive, royalty-free license to store and process your User Content solely for the purpose of providing the Service.</p>
            <p style={S.body(t)}>You are solely responsible for the accuracy and legality of the data you import or create in Nous, including compliance with applicable data protection laws regarding the contacts you store.</p>
          </Section>

          <Section t={t} title="6. AI-Generated Memory">
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["You own the memory facts and context synthesized from your data","AI-synthesized memory may not be entirely accurate and should be reviewed","We do not guarantee the accuracy or completeness of synthesized facts","You are responsible for reviewing agent outputs before acting on them","We do not use your data to train AI models"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="7. Acceptable Use">
            <p style={S.body(t)}>You agree not to use the Service to:</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Violate any applicable laws or regulations","Store or process data without appropriate legal basis","Spam, harass, or abuse contacts stored in the platform","Attempt to gain unauthorized access to the Service or its systems","Abuse the MCP server or API beyond reasonable rate limits","Reverse engineer, decompile, or disassemble the Service"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="8. Intellectual Property">
            <p style={S.body(t)}>The Service and its original content, features, and functionality are owned by Nous and are protected by international copyright, trademark, and other intellectual property laws. Our trademarks may not be used without prior written consent.</p>
          </Section>

          <Section t={t} title="9. Disclaimer of Warranties">
            <p style={S.body(t)}>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE.</p>
          </Section>

          <Section t={t} title="10. Limitation of Liability">
            <p style={S.body(t)}>TO THE MAXIMUM EXTENT PERMITTED BY LAW, NOUS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES.</p>
            <p style={S.body(t)}>Our total liability for any claims shall not exceed the amount you paid to us during the twelve (12) months preceding the claim.</p>
          </Section>

          <Section t={t} title="11. Termination">
            <p style={S.body(t)}>We may terminate or suspend your account immediately, without prior notice, for any breach of these Terms. Upon termination, your right to use the Service ceases. You may export your data before termination.</p>
          </Section>

          <Section t={t} title="12. Governing Law">
            <p style={S.body(t)}>These Terms shall be governed by and construed in accordance with the laws of Germany. Any disputes shall be resolved exclusively in the courts of Germany.</p>
          </Section>

          <Section t={t} title="13. Changes to Terms">
            <p style={S.body(t)}>We reserve the right to modify these Terms at any time. We will provide notice of material changes by posting the updated Terms and updating the "Last updated" date. Continued use of the Service constitutes acceptance.</p>
          </Section>

          <div style={S.divider(t)} />

          <Section t={t} title="14. Contact">
            <div style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted, lineHeight: 1.9 }}>
              <p><span style={{ color: t.text, fontFamily: "JetBrains Mono, monospace" }}>Nous</span> — {legalEntity.operatorName}</p>
              <p>{legalAddress}</p>
              <p>Email: <a href={`mailto:${legalEntity.email}`} style={S.link(t)}>{legalEntity.email}</a></p>
              <p>Web: <a href="https://opennous.cloud" style={S.link(t)}>opennous.cloud</a></p>
            </div>
          </Section>
        </>
      )}
    </NousPageLayout>
  );
}
