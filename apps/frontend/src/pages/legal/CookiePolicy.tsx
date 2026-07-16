import { NousPageLayout, Theme } from "@/components/NousPageLayout";
import { legalEntity, legalAddress } from "@/config/legal";

const S = {
  label: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.accent, textTransform: "uppercase" as const, letterSpacing: "0.18em", marginBottom: "10px" }),
  h1: (t: Theme) => ({ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "clamp(1.8rem,3.5vw,2.4rem)", color: t.text, lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: "12px" }),
  meta: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted }),
  h2: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "13px", fontWeight: 600, color: t.text, marginBottom: "12px", marginTop: "0" }),
  subLabel: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.muted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "8px" }),
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

export default function CookiePolicy() {
  return (
    <NousPageLayout
      seoTitle="Cookie Policy | Nous"
      seoDescription="Learn about how Nous uses cookies and similar technologies."
    >
      {(t) => (
        <>
          <div style={{ marginBottom: "48px" }}>
            <p style={S.label(t)}># Legal</p>
            <h1 style={S.h1(t)}>Cookie Policy</h1>
            <p style={S.meta(t)}>Last updated: April 21, 2026</p>
          </div>

          <Section t={t} title="1. Introduction">
            <p style={S.body(t)}>This Cookie Policy explains how Nous uses cookies and similar tracking technologies when you visit opennous.cloud and use our platform. By using the Service, you consent to the use of cookies in accordance with this policy.</p>
          </Section>

          <Section t={t} title="2. What Are Cookies?">
            <p style={S.body(t)}>Cookies are small text files stored on your device when you visit a website. They help websites function properly and provide information to site owners. Cookies can be persistent (remaining after you close your browser) or session-based (deleted when you close your browser).</p>
          </Section>

          <Section t={t} title="3. How We Use Cookies">
            <p style={S.subLabel(t)}>Essential cookies</p>
            <p style={S.body(t)}>Required for the Service to function. Cannot be disabled.</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Authentication: keeping you logged in","Security: preventing fraudulent activity","Session management: remembering preferences"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
            <p style={S.subLabel(t)}>Analytics cookies</p>
            <p style={S.body(t)}>Help us understand how users interact with the Service.</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Google Analytics: website traffic and usage patterns","PostHog: product analytics and user behavior"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
            <p style={S.subLabel(t)}>Functional cookies</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Display and language preferences","Feature configurations"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="4. Third-Party Cookies">
            <p style={S.body(t)}>Some cookies are placed by third-party services. We do not control these cookies.</p>
            <div style={{ border: `1px solid ${t.border}`, borderRadius: "10px", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                    {["Provider","Purpose"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: t.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[["Google Analytics","Website analytics"],["PostHog","Product analytics"],["Stripe","Payment processing"],["Supabase","Authentication"]].map(([provider, purpose]) => (
                    <tr key={provider} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "10px 14px", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.text }}>{provider}</td>
                      <td style={{ padding: "10px 14px", fontFamily: "Inter, sans-serif", fontSize: "13px", color: t.muted }}>{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section t={t} title="5. Managing Cookies">
            <p style={S.body(t)}>You can control cookies through your browser settings. Note that disabling cookies may impact your experience.</p>
            <p style={S.subLabel(t)}>Browser settings</p>
            <ul style={{ listStyle: "none", padding: 0, marginBottom: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Chrome: Settings → Privacy and Security → Cookies","Firefox: Options → Privacy & Security → Cookies","Safari: Preferences → Privacy → Cookies","Edge: Settings → Privacy → Cookies"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
            <p style={S.subLabel(t)}>Opt-out links</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
              {["Google Analytics: tools.google.com/dlpage/gaoptout","Your Online Choices (EU): youronlinechoices.com"].map(i => <Li key={i} t={t}>{i}</Li>)}
            </ul>
          </Section>

          <Section t={t} title="6. Local Storage">
            <p style={S.body(t)}>In addition to cookies, we use local storage to store authentication tokens, workspace preferences, and API key references on your device.</p>
          </Section>

          <Section t={t} title="7. Updates">
            <p style={S.body(t)}>We may update this Cookie Policy from time to time. Changes will be posted on this page with an updated date.</p>
          </Section>

          <div style={S.divider(t)} />

          <Section t={t} title="8. Contact">
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
