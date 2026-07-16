import { NousPageLayout, Theme } from "@/components/NousPageLayout";
import { legalEntity, legalAddress } from "@/config/legal";

const S = {
  label: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: t.accent, textTransform: "uppercase" as const, letterSpacing: "0.18em", marginBottom: "10px" }),
  h1: (t: Theme) => ({ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "clamp(1.8rem,3.5vw,2.4rem)", color: t.text, lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: "12px" }),
  meta: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted }),
  h2: (t: Theme) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "13px", fontWeight: 600, color: t.text, marginBottom: "12px", marginTop: "0" }),
  body: (t: Theme) => ({ fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted, lineHeight: 1.75, marginBottom: "12px" }),
  link: (t: Theme) => ({ color: t.accent, textDecoration: "underline" as const }),
  divider: (t: Theme) => ({ borderTop: `1px solid ${t.border}`, margin: "40px 0" }),
  section: { marginBottom: "36px" },
};

function Section({ t, title, children }: { t: Theme; title: string; children: React.ReactNode }) {
  return <section style={S.section}><h2 style={S.h2(t)}>{title}</h2>{children}</section>;
}

export default function Impressum() {
  return (
    <NousPageLayout
      seoTitle="Impressum | Nous"
      seoDescription="Legal notice and company information for Nous — the context graph for agentic GTM teams."
    >
      {(t) => (
        <>
          <div style={{ marginBottom: "48px" }}>
            <p style={S.label(t)}># Legal</p>
            <h1 style={S.h1(t)}>Impressum</h1>
            <p style={S.meta(t)}>Legal notice according to § 5 TMG</p>
          </div>

          <Section t={t} title="Company Information">
            <div style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", color: t.muted, lineHeight: 1.9 }}>
              <p><span style={{ color: t.text, fontFamily: "JetBrains Mono, monospace" }}>Nous</span> — {legalEntity.operatorName}</p>
              <p>{legalAddress}</p>
              <p style={{ marginTop: "8px" }}>Email: <a href={`mailto:${legalEntity.email}`} style={S.link(t)}>{legalEntity.email}</a></p>
              <p>Phone: {legalEntity.phone}</p>
              <p>Web: <a href={`https://${legalEntity.web}`} style={S.link(t)}>{legalEntity.web}</a></p>
            </div>
          </Section>

          <Section t={t} title="VAT Information">
            <p style={S.body(t)}>VAT ID (USt-IdNr.): <span style={{ color: t.text, fontFamily: "JetBrains Mono, monospace" }}>{legalEntity.vatId}</span> — according to § 27a UStG</p>
          </Section>

          <Section t={t} title="Responsible for Content (§ 55 Abs. 2 RStV)">
            <p style={S.body(t)}>{legalEntity.operatorName} · {legalAddress}</p>
          </Section>

          <Section t={t} title="EU Online Dispute Resolution">
            <p style={S.body(t)}>The European Commission provides a platform for online dispute resolution (ODR): <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer" style={S.link(t)}>ec.europa.eu/consumers/odr</a></p>
            <p style={S.body(t)}>We are not obligated nor willing to participate in dispute resolution proceedings before a consumer arbitration board.</p>
          </Section>

          <Section t={t} title="Liability for Content">
            <p style={S.body(t)}>As a service provider, we are responsible for our own content on these pages according to § 7 Abs.1 TMG. According to §§ 8 to 10 TMG, we are not obligated to monitor transmitted or stored third-party information. Liability is only possible from the point in time at which we become aware of a specific legal violation. Upon notification, we will remove such content immediately.</p>
          </Section>

          <Section t={t} title="Liability for Links">
            <p style={S.body(t)}>Our website contains links to external third-party websites over whose content we have no control. The respective provider or operator is always responsible for the content of linked pages. Upon notification of violations, we will remove such links immediately.</p>
          </Section>

          <div style={S.divider(t)} />

          <Section t={t} title="Copyright">
            <p style={S.body(t)}>The content and works on these pages are subject to German copyright law. Duplication, processing, distribution, and any use outside copyright law require written consent. Downloads and copies are only permitted for private, non-commercial use.</p>
          </Section>
        </>
      )}
    </NousPageLayout>
  );
}
