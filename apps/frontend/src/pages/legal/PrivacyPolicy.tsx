import { NousPageLayout, Theme } from "@/components/NousPageLayout";
import { legalEntity, legalAddress } from "@/config/legal";

const S = {
  label: (t: Theme) => ({
    fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.accent,
    textTransform: "uppercase" as const, letterSpacing: "0.18em", marginBottom: "10px",
  }),
  h1: (t: Theme) => ({
    fontFamily: "Instrument Serif, Georgia, serif", fontSize: "clamp(1.8rem,3.5vw,2.4rem)",
    color: t.text, lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: "12px",
  }),
  meta: (t: Theme) => ({
    fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted,
  }),
  h2: (t: Theme) => ({
    fontFamily: "JetBrains Mono, monospace", fontSize: "13px", fontWeight: 600,
    color: t.text, marginBottom: "12px", marginTop: "0",
  }),
  subLabel: (t: Theme) => ({
    fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.muted,
    textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "8px",
  }),
  body: (t: Theme) => ({
    fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted,
    lineHeight: 1.75, marginBottom: "12px",
  }),
  li: (t: Theme) => ({
    fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted,
    lineHeight: 1.7, paddingLeft: "0",
  }),
  link: (t: Theme) => ({
    color: t.accent, textDecoration: "underline",
  }),
  divider: (t: Theme) => ({
    borderTop: `1px solid ${t.border}`, margin: "40px 0",
  }),
  section: { marginBottom: "36px" },
};

function Section({ t, title, children }: { t: Theme; title: string; children: React.ReactNode }) {
  return (
    <section style={S.section}>
      <h2 style={S.h2(t)}>{title}</h2>
      {children}
    </section>
  );
}

function Li({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <li style={S.li(t)}>— {children}</li>;
}

export default function PrivacyPolicy() {
  return (
    <NousPageLayout
      seoTitle="Privacy Policy | Nous"
      seoDescription="Learn how Nous collects, uses, and protects your personal information."
    >
      {(t) => (
        <>
          <div style={{ marginBottom: "48px" }}>
            <p style={S.label(t)}># Legal</p>
            <h1 style={S.h1(t)}>Privacy Policy</h1>
            <p style={S.meta(t)}>Last updated: April 21, 2026</p>
          </div>

          <Section t={t} title="1. Introduction">
            <p style={S.body(t)}>Nous ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use Nous — the GTM Context API for agents — and related services at opennous.cloud.</p>
            <p style={S.body(t)}>By using the Service, you agree to the collection and use of information in accordance with this policy.</p>
          </Section>

          <Section t={t} title="2. Information We Collect">
            <p style={S.subLabel(t)}>Information you provide</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Name, email address, company name, and password","Payment details (processed via Stripe)","Contact and company data you import or create in the platform","Activity logs and memory entries you write via the API or MCP"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
            <p style={S.subLabel(t)}>Collected automatically</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Usage data: features accessed, API calls made, memory reads/writes","Device and browser information","IP address, access times, pages viewed","Cookies and similar tracking technologies"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="3. How We Use Your Information">
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Provide, maintain, and improve the Service","Process and serve agent memory requests via MCP and REST API","Process transactions and send related information","Send technical notices, updates, and support messages","Monitor usage, detect abuse, and prevent fraud","Respond to support requests"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="4. Agent Memory Processing">
            <p style={S.body(t)}>Nous processes contact and company data on your behalf to build and serve persistent memory for your AI agents:</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Your contact and account data is processed by AI providers (Anthropic, OpenAI) to synthesize memory facts","We do not use your data to train AI models","You retain ownership of all data you import or create in Nous","Memory data is processed securely and not shared with third parties outside of operating the Service"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="5. Information Sharing">
            <p style={S.body(t)}>We may share your information with:</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "12px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[["Service providers","that perform services on our behalf"],["Business transfers","in connection with a merger, acquisition, or sale"],["Legal requirements","when required by law or to protect our rights"],["With your consent","when you explicitly authorize sharing"]].map(([bold, rest]) => (
                <li key={bold} style={S.li(t)}>— <span style={{ color: t.text, fontWeight: 500 }}>{bold}</span> {rest}</li>
              ))}
            </ul>
            <p style={S.body(t)}>We do not sell your personal information to third parties.</p>
          </Section>

          <Section t={t} title="6. Subprocessors">
            <p style={S.body(t)}>We use the following third-party services to operate Nous:</p>
            <div style={{ border: `1px solid ${t.border}`, borderRadius: "10px", overflow: "hidden", marginBottom: "12px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                    {["Service","Purpose","Location"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: t.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[["Supabase","Database, auth, file storage","USA"],["Stripe","Payment processing","USA"],["PostHog","Product analytics","EU/USA"],["Anthropic (Claude)","Memory synthesis AI","USA"],["OpenAI","Text embeddings","USA"],["Resend","Transactional email","USA"]].map(([svc, purpose, loc]) => (
                    <tr key={svc} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "10px 14px", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.text }}>{svc}</td>
                      <td style={{ padding: "10px 14px", fontFamily: "Inter, sans-serif", fontSize: "13px", color: t.muted }}>{purpose}</td>
                      <td style={{ padding: "10px 14px", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.muted }}>{loc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ ...S.meta(t), lineHeight: 1.6 }}>All subprocessors are contractually obligated to process data only as instructed. For transfers to the USA, we rely on Standard Contractual Clauses (SCCs).</p>
          </Section>

          <Section t={t} title="7. Data Security">
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Encryption in transit (TLS/SSL) and at rest","Access controls and authentication mechanisms","Regular security assessments","Secure infrastructure with physical security measures"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="8. Data Retention">
            <p style={S.body(t)}>We retain your data for as long as your account is active or as needed to provide the Service. Upon account deletion, we will delete or anonymize your information within 30 days, except where required for legal compliance.</p>
          </Section>

          <Section t={t} title="9. Your Rights (GDPR)">
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "12px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[["Access","request access to your personal data"],["Correction","request correction of inaccurate data"],["Deletion","request deletion of your personal data"],["Portability","request your data in a portable format"],["Objection","object to certain processing"]].map(([bold, rest]) => (
                <li key={bold} style={S.li(t)}>— <span style={{ color: t.text, fontWeight: 500 }}>{bold}</span> — {rest}</li>
              ))}
            </ul>
            <p style={S.body(t)}>To exercise these rights, contact us at <a href={`mailto:${legalEntity.email}`} style={S.link(t)}>{legalEntity.email}</a>.</p>
          </Section>

          <Section t={t} title="10. Children's Privacy">
            <p style={S.body(t)}>The Service is not intended for individuals under 18. We do not knowingly collect personal information from children.</p>
          </Section>

          <Section t={t} title="11. Changes to This Policy">
            <p style={S.body(t)}>We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the updated policy on this page and updating the "Last updated" date.</p>
          </Section>

          <div style={S.divider(t)} />

          <Section t={t} title="12. Contact / Data Controller">
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
