const VALUE_PROPS = [
  {
    title: "No interest, ever",
    body: "No compounding, no percentage-based late fees, and no charges for taking longer to pay. Repayment terms cannot silently grow the debt.",
  },
  {
    title: "Money moves only when it clears",
    body: "Recipients are paid through a qualified payment processor as each installment settles. PAY2PAY is not a lender and does not advance or hold customer funds.",
  },
  {
    title: "Full lifecycle support",
    body: "Failed-payment retries, hardship requests, partial payments, early payoff, settlements, and disputes are first-class, auditable workflows.",
  },
  {
    title: "Built-in evidence and audit trail",
    body: "Supporting documents, tamper-evident signed records, witness attestations, and an append-only audit log make an agreement defensible later.",
  },
];

const STEPS = [
  {
    title: "Draft",
    body: "One party states what's owed, why, and the proposed repayment schedule.",
  },
  {
    title: "Acknowledge",
    body: "Both parties confirm the same facts: amount, reason, prior payments, and remaining balance.",
  },
  {
    title: "Accept",
    body: "A mandatory final review screen surfaces the full terms in plain language before anything is binding.",
  },
  {
    title: "Sign",
    body: "Both parties sign electronically and receive a tamper-evident copy of the agreement.",
  },
];

const RELATIONSHIP_SHAPES = [
  {
    title: "Personal-to-personal",
    body: "Friends and family formalizing an informal loan into a documented, trackable repayment plan.",
  },
  {
    title: "Business-to-consumer",
    body: "Small businesses, contractors, and service providers offering installment repayment on completed work.",
  },
  {
    title: "Consumer-to-business",
    body: "An individual repaying a verified business for goods or services already delivered.",
  },
  {
    title: "Business-to-business",
    body: "Verified businesses collecting past-due or scheduled invoices from another business, both acting through authorized representatives.",
  },
];

const NOT_STATEMENTS = [
  "Not a lender, and not in the business of advancing loan proceeds.",
  "Not a guarantor of repayment.",
  "Not an intentional custodian of customer funds.",
  'Not a Sharia-certified financial product — "influenced by" Islamic debt principles, but no formal compliance claim is made absent qualified scholarly review.',
  "Not a debt collector, debt buyer, or payday lender.",
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <span className="badge">Presentation preview — no live agreements or payments</span>
        <h1>Turn what&apos;s owed into a documented, signed repayment plan</h1>
        <p className="hero__lede">
          PAY2PAY is an ethical, interest-free repayment platform. It helps two parties document
          an existing debt, get both signatures, and track repayment through a qualified payment
          processor — without ever acting as a lender or holding customer funds.
        </p>
        <div className="hero__actions">
          <button type="button" className="button button--primary" aria-disabled="true" disabled>
            Start an agreement (not yet available)
          </button>
          <a className="button button--secondary" href="#how-it-works">
            See how it works
          </a>
        </div>
        <p className="disclaimer-banner">
          This is a presentation-layer preview of the PAY2PAY product. No accounts, agreements,
          signatures, or payments are functional yet. See <code>docs/IMPLEMENTATION_PLAN.md</code>{" "}
          for build status.
        </p>
      </section>

      <section className="section" aria-labelledby="value-props-heading">
        <div className="section-heading">
          <h2 id="value-props-heading">What makes it different</h2>
          <p>Principles carried through every part of the platform, not just marketing copy.</p>
        </div>
        <div className="grid grid--cols-2">
          {VALUE_PROPS.map((item) => (
            <div className="card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="how-it-works" aria-labelledby="how-it-works-heading">
        <div className="section-heading">
          <h2 id="how-it-works-heading">How an agreement will work</h2>
          <p>The planned draft-to-signature flow. Not yet available to use.</p>
        </div>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="relationships-heading">
        <div className="section-heading">
          <h2 id="relationships-heading">Built for four kinds of relationships</h2>
          <p>The same plain-language agreement flow, adapted to who&apos;s involved.</p>
        </div>
        <div className="grid grid--cols-2">
          {RELATIONSHIP_SHAPES.map((shape) => (
            <div className="card card--accent" key={shape.title}>
              <h3>{shape.title}</h3>
              <p>{shape.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="trust-heading">
        <div className="section-heading">
          <h2 id="trust-heading">What PAY2PAY is not</h2>
          <p>
            Stated plainly so the platform&apos;s scope is never overclaimed, live or otherwise.
          </p>
        </div>
        <div className="card" style={{ maxWidth: "var(--max-text-width)", marginInline: "auto" }}>
          <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
            {NOT_STATEMENTS.map((statement) => (
              <li key={statement}>{statement}</li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
