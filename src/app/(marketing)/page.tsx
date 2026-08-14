import { EarlyAccessForm } from "@/components/EarlyAccessForm";

const VALUE_PROPS = [
  {
    eyebrow: "Clear terms",
    title: "No interest. No moving target.",
    body: "The balance does not grow simply because repayment takes time. Both parties see the same principal, dates, and fee allocation before signing.",
    icon: "document",
  },
  {
    eyebrow: "Mutual control",
    title: "Changes require both parties.",
    body: "Payment pauses, reduced installments, settlements, and schedule changes are documented as amendments instead of silent edits.",
    icon: "handshake",
  },
  {
    eyebrow: "Direct repayment",
    title: "Funds move after they clear.",
    body: "PAY2PAY is designed to route cleared installments through a qualified processor to the verified recipient—without acting as a lender.",
    icon: "transfer",
  },
  {
    eyebrow: "Defensible records",
    title: "Every important action is recorded.",
    body: "Signed versions, supporting documents, payment history, and later evidence remain tied to an auditable agreement timeline.",
    icon: "shield",
  },
];

const STEPS = [
  {
    number: "01",
    title: "Create the terms",
    body: "Document what is owed, why it is owed, prior payments, the first payment, and the proposed schedule.",
  },
  {
    number: "02",
    title: "Review together",
    body: "The debtor acknowledges the obligation and both parties review the same plain-language summary.",
  },
  {
    number: "03",
    title: "Approve and sign",
    body: "Both parties confirm the final terms. The signed version is locked and preserved.",
  },
  {
    number: "04",
    title: "Track repayment",
    body: "Installments, failed payments, amendments, settlements, and supporting evidence follow one timeline.",
  },
];

const RELATIONSHIP_SHAPES = [
  {
    title: "Personal repayment",
    body: "Turn an informal debt between friends or family into a clear plan without awkward spreadsheets or scattered messages.",
    tag: "P2P",
  },
  {
    title: "Customer payment plans",
    body: "Give customers a structured way to repay completed work or delivered goods while preserving the original invoice terms.",
    tag: "B2C",
  },
  {
    title: "Business repayment",
    body: "Let an individual repay a verified business through a transparent, mutually approved schedule.",
    tag: "C2B",
  },
  {
    title: "Commercial receivables",
    body: "Create B2B repayment agreements tied to invoices, purchase orders, contracts, and authorized representatives.",
    tag: "B2B",
  },
];

const TRUST_POINTS = [
  "Interest-free by design",
  "Both parties approve changes",
  "No platform-funded loans",
  "No repayment guarantees",
];

function FeatureIcon({ name }: { name: string }) {
  if (name === "document") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.75h7.25L18.25 7.75V20.25H7V3.75Z" />
        <path d="M14 3.75V8H18.25M9.5 12H15.5M9.5 15.5H14" />
      </svg>
    );
  }

  if (name === "handshake") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.25 8.75 11 6.25c.8-.72 2.02-.7 2.8.05l1.2 1.15h3.25l2 2.25-5.78 5.8a2 2 0 0 1-2.82 0L8.25 12.1" />
        <path d="m3.75 8.25 3-2.5 3 3.5-3.5 3.25-2.5-4.25Zm16.5.5-2-2.5-2.75 2.5 3 3.25 1.75-3.25ZM8 13.75l1.75 1.75M10.25 16l1.5 1.5" />
      </svg>
    );
  }

  if (name === "transfer") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8.25h13.5M14.5 5.25l3 3-3 3M20 15.75H6.5M9.5 12.75l-3 3 3 3" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.25c0 4.6-2.85 7.68-7 9.25-4.15-1.57-7-4.65-7-9.25V6l7-2.5Z" />
      <path d="m8.75 11.75 2.1 2.1 4.4-4.7" />
    </svg>
  );
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="Preview of a PAY2PAY agreement dashboard">
      <div className="preview-window">
        <div className="preview-window__bar">
          <span />
          <span />
          <span />
          <p>Agreement overview</p>
        </div>
        <div className="preview-window__content">
          <div className="preview-sidebar" aria-hidden="true">
            <div className="preview-logo">P2P</div>
            <span className="preview-nav-item preview-nav-item--active" />
            <span className="preview-nav-item" />
            <span className="preview-nav-item" />
            <span className="preview-nav-item" />
          </div>
          <div className="preview-dashboard">
            <div className="preview-dashboard__heading">
              <div>
                <span className="preview-kicker">ACTIVE AGREEMENT</span>
                <h2>Equipment repayment</h2>
              </div>
              <span className="status-pill">On schedule</span>
            </div>

            <div className="preview-stats">
              <div>
                <span>Remaining balance</span>
                <strong>$2,400</strong>
              </div>
              <div>
                <span>Next payment</span>
                <strong>$200</strong>
              </div>
              <div>
                <span>Payments made</span>
                <strong>3 of 15</strong>
              </div>
            </div>

            <div className="preview-progress">
              <div className="preview-progress__meta">
                <span>Repayment progress</span>
                <strong>20%</strong>
              </div>
              <div className="preview-progress__track">
                <span />
              </div>
            </div>

            <div className="preview-timeline">
              <div className="timeline-row timeline-row--complete">
                <span className="timeline-dot" />
                <div>
                  <strong>Agreement signed</strong>
                  <small>Both parties approved</small>
                </div>
                <time>May 4</time>
              </div>
              <div className="timeline-row timeline-row--complete">
                <span className="timeline-dot" />
                <div>
                  <strong>Payment received</strong>
                  <small>Cleared and recorded</small>
                </div>
                <time>Jul 1</time>
              </div>
              <div className="timeline-row">
                <span className="timeline-dot" />
                <div>
                  <strong>Next installment</strong>
                  <small>Scheduled payment</small>
                </div>
                <time>Aug 1</time>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="floating-card floating-card--top">
        <span className="floating-card__icon">✓</span>
        <div>
          <strong>Mutually approved</strong>
          <small>Terms locked after signing</small>
        </div>
      </div>
      <div className="floating-card floating-card--bottom">
        <span className="floating-card__icon floating-card__icon--gold">$</span>
        <div>
          <strong>Interest-free</strong>
          <small>Principal does not grow with time</small>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero__copy">
          <span className="eyebrow"><span /> A clearer way to repay what&apos;s owed</span>
          <h1 id="hero-heading">
            Turn an obligation into a plan <em>both sides can trust.</em>
          </h1>
          <p className="hero__lede">
            PAY2PAY helps people and businesses create clear, interest-free repayment agreements,
            approve changes together, and keep every important step in one documented timeline.
          </p>
          <div className="hero__actions">
            <a className="button button--primary button--large" href="#how-it-works">
              Explore how it works
              <span aria-hidden="true">→</span>
            </a>
            <a className="button button--ghost button--large" href="#use-cases">
              See who it&apos;s for
            </a>
          </div>
          <div className="hero__trust" aria-label="PAY2PAY product principles">
            {TRUST_POINTS.map((point) => (
              <span key={point}><b aria-hidden="true">✓</b>{point}</span>
            ))}
          </div>
          <p className="preview-note">
            Early access: account creation, agreements, signatures, and payments are live for
            signed-up users.
          </p>
        </div>
        <ProductPreview />
      </section>

      <section className="proof-strip" aria-label="Core product capabilities">
        <div>
          <strong>P2P</strong>
          <span>Personal repayment</span>
        </div>
        <div>
          <strong>B2C</strong>
          <span>Customer payment plans</span>
        </div>
        <div>
          <strong>C2B</strong>
          <span>Business repayment</span>
        </div>
        <div>
          <strong>B2B</strong>
          <span>Commercial receivables</span>
        </div>
      </section>

      <section className="section section--features" aria-labelledby="value-props-heading">
        <div className="section-heading section-heading--split">
          <div>
            <span className="eyebrow"><span /> Built around the agreement</span>
            <h2 id="value-props-heading">Structure without turning repayment into another loan.</h2>
          </div>
          <p>
            PAY2PAY is designed to make obligations clearer—not larger. The experience centers on
            mutual consent, transparent records, and a repayment schedule both parties understand.
          </p>
        </div>
        <div className="feature-grid">
          {VALUE_PROPS.map((item) => (
            <article className="feature-card" key={item.title}>
              <div className="feature-card__icon"><FeatureIcon name={item.icon} /></div>
              <span>{item.eyebrow}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--process" id="how-it-works" aria-labelledby="how-it-works-heading">
        <div className="process-layout">
          <div className="process-intro">
            <span className="eyebrow eyebrow--light"><span /> One shared record</span>
            <h2 id="how-it-works-heading">From conversation to signed repayment plan.</h2>
            <p>
              Replace vague promises and scattered messages with a structured process that preserves
              what both parties agreed to—and what happens next.
            </p>
            <a className="text-link" href="#use-cases">Explore repayment use cases <span aria-hidden="true">→</span></a>
          </div>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.title}>
                <span className="steps__number">{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="use-cases" aria-labelledby="relationships-heading">
        <div className="section-heading">
          <span className="eyebrow"><span /> Flexible by relationship</span>
          <h2 id="relationships-heading">Built for personal obligations and business receivables.</h2>
          <p>The same transparent agreement model, adapted to the people and organizations involved.</p>
        </div>
        <div className="relationship-grid">
          {RELATIONSHIP_SHAPES.map((shape) => (
            <article className="relationship-card" key={shape.title}>
              <div className="relationship-card__tag">{shape.tag}</div>
              <div>
                <h3>{shape.title}</h3>
                <p>{shape.body}</p>
              </div>
              <span className="relationship-card__arrow" aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--trust" aria-labelledby="trust-heading">
        <div className="trust-panel">
          <div className="trust-panel__copy">
            <span className="eyebrow eyebrow--light"><span /> Honest by design</span>
            <h2 id="trust-heading">A repayment platform—not a lender, collector, or guarantor.</h2>
            <p>
              PAY2PAY is being built to document and facilitate repayment through qualified providers.
              It does not advance funds, guarantee repayment, or claim formal Sharia certification.
            </p>
          </div>
          <div className="trust-panel__facts">
            <div><strong>0%</strong><span>interest added by PAY2PAY</span></div>
            <div><strong>2</strong><span>parties required for term changes</span></div>
            <div><strong>1</strong><span>shared agreement timeline</span></div>
          </div>
        </div>
      </section>

      <section className="early-access" id="early-access" aria-labelledby="early-access-heading">
        <div className="early-access__copy">
          <span className="eyebrow"><span /> In active development</span>
          <h2 id="early-access-heading">Get on the early-access list.</h2>
          <p>
            PAY2PAY is currently in its product-development stage. Functional accounts, agreements,
            signatures, and payments are not enabled yet. Joining early access does not create an
            account — it lets us reach out as new capabilities become available.
          </p>
          <ul>
            <li><b aria-hidden="true">✓</b>No bank account, card, SSN, or government ID requested here.</li>
            <li><b aria-hidden="true">✓</b>You can ask us to remove your information at any time.</li>
          </ul>
        </div>
        <EarlyAccessForm />
      </section>
    </>
  );
}
