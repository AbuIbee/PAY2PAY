import Image from "next/image";
import Link from "next/link";
import styles from "./home.module.css";

const PERSONAL_FEATURES = ["Personal Dashboard", "Agreements", "Payments", "Connections", "Profile"];
const BUSINESS_FEATURES = ["Dashboard", "Outstanding Balances", "Customers", "Agreements", "Employees", "Organization Settings", "Billing & Subscription"];

const INDUSTRIES = [
  { icon: "T", title: "Trucking", body: "Keep customer balances, agreements, and repayment follow-through visible across the operation.", bullets: ["Outstanding balances", "Agreement visibility", "Document-backed follow-up"] },
  { icon: "F", title: "Freight", body: "Give teams a clearer operating view across counterparties, arrangements, and customer obligations.", bullets: ["Customer coordination", "Agreement tracking", "Clear follow-through"] },
  { icon: "3", title: "3PL", body: "Manage multiple customers and internal users without losing the connection between the balance and the agreement.", bullets: ["Multi-customer visibility", "Employee access", "Centralized records"] },
  { icon: "R", title: "Retail", body: "Bring high-volume customer balances into a structured agreement workflow with clearer documentation.", bullets: ["Customer balances", "Structured arrangements", "Documented history"] },
];

function PreviewCard({ business = false }: { business?: boolean }) {
  return (
    <div className={business ? styles.businessPreview : styles.personalPreview}>
      <div className={styles.previewTop}>
        <div className={styles.previewIdentity}>
          <span className={styles.previewIcon} aria-hidden="true">{business ? "B" : "P"}</span>
          <div><strong>{business ? "Paid2You Business" : "My Paid2You"}</strong><small>{business ? "Business Account" : "Personal Account"}</small></div>
        </div>
        <small>{business ? "Business" : "Personal"}</small>
      </div>
      <div className={styles.previewBody}>
        {business ? <div className={styles.businessStatus}>Business workspace · Sample dashboard</div> : null}
        <div className={styles.previewImage}>
          <Image src={business ? "/home/homepageanalytics.png" : "/home/laptop_and_truck.png"} alt="" fill sizes={business ? "(max-width: 700px) 78vw, 34vw" : "(max-width: 700px) 70vw, 24vw"} priority={business} />
        </div>
        <div className={styles.previewStats} aria-label={business ? "Sample Business dashboard metrics" : "Sample Personal dashboard metrics"}>
          {business ? <>
            <div><span>Outstanding Balances</span><strong>$24,850</strong></div>
            <div><span>Customers</span><strong>28</strong></div>
            <div><span>Employees</span><strong>14</strong></div>
            <div><span>Agreements</span><strong>74</strong></div>
          </> : <>
            <div><span>Agreements</span><strong>12</strong></div>
            <div><span>Payments</span><strong>$3,280</strong></div>
            <div><span>Connections</span><strong>8</strong></div>
            <div><span>Profile</span><strong>Complete</strong></div>
          </>}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className={styles.home}>
      <section className={styles.hero} aria-labelledby="home-hero-title">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>AGREEMENTS. PAYMENTS. CONNECTIONS.</div>
            <h1 id="home-hero-title">One platform.<br /><span>Business and Personal.</span></h1>
            <p>Paid2You gives businesses a dedicated operating experience for teams, outstanding balances, customers, and agreements, while My Paid2You remains a complete Personal account for individual agreements, payments, and connections.</p>
            <div className={styles.actions}>
              <Link className={styles.primaryCta} href="/signup?accountType=business">Create Business Account <span aria-hidden="true">→</span></Link>
              <Link className={styles.secondaryCta} href="/signup?accountType=personal">Create Personal Account <span aria-hidden="true">→</span></Link>
            </div>
            <div className={styles.ctaNotes} aria-hidden="true"><span>For teams, fleets, 3PLs, retailers, and growing businesses</span><span>Personal account · Get started in minutes</span></div>
          </div>
          <div className={styles.heroVisual} aria-label="Sample Paid2You Personal and Business dashboards"><PreviewCard /><PreviewCard business /></div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="accounts-title">
        <div className={styles.sectionTitle}><h2 id="accounts-title">Two account experiences. One Paid2You platform.</h2><p>Business leads the commercial experience. Personal remains a first-class path and can introduce future business users to Paid2You.</p></div>
        <div className={styles.workspaceGrid}>
          <article className={styles.workspaceCard} id="personal">
            <div className={styles.workspaceImage}><Image src="/home/laptop_and_truck.png" alt="" fill sizes="(max-width: 70rem) 100vw, 42vw" /></div>
            <div className={styles.workspaceContent}><div className={styles.workspaceHeading}><span className={styles.workspaceBadge} aria-hidden="true">P</span><div><h3>My Paid2You</h3><p>A dedicated Personal account for your own agreements and connections.</p></div></div><ul className={styles.features}>{PERSONAL_FEATURES.map((f) => <li key={f}>{f}</li>)}</ul></div>
          </article>
          <article className={`${styles.workspaceCard} ${styles.businessCard}`} id="business">
            <div className={styles.workspaceImage}><Image src="/home/12checkTrucking.png" alt="" fill sizes="(max-width: 70rem) 100vw, 48vw" /></div>
            <div className={styles.workspaceContent}><div className={styles.workspaceHeading}><span className={styles.workspaceBadge} aria-hidden="true">B</span><div><h3>Paid2You Business</h3><p>Subscription-based tools for organizations managing customer balances and agreements.</p></div></div><ul className={styles.features}>{BUSINESS_FEATURES.map((f) => <li key={f}>{f}</li>)}</ul></div>
          </article>
        </div>
      </section>

      <section className={styles.industrySection} aria-labelledby="industries-title">
        <div className={styles.industryInner}>
          <div className={styles.sectionTitle}><h2 id="industries-title">Built for demanding business balance and agreement workflows.</h2><p>Paid2You Business launches around Trucking, Freight, 3PL, and Retail without limiting where the platform can grow.</p></div>
          <div className={styles.industryBanner}><Image src="/home/4Categories.png" alt="" fill sizes="100vw" /></div>
          <div className={styles.industryGrid}>{INDUSTRIES.map((industry) => <article className={styles.industryCard} key={industry.title}><span className={styles.industryIcon} aria-hidden="true">{industry.icon}</span><h3>{industry.title}</h3><p>{industry.body}</p><ul>{industry.bullets.map((b) => <li key={b}>{b}</li>)}</ul></article>)}</div>
        </div>
      </section>

      <section className={styles.section}><div className={styles.finalCta}><div><h2>Choose the Paid2You account that fits what you need today.</h2><p>Business and Personal stay visibly connected under one brand while keeping their account paths clear.</p></div><div className={styles.actions}><Link className={styles.primaryCta} href="/signup?accountType=business">Get Paid2You Business</Link><Link className={styles.secondaryCta} href="/signup?accountType=personal">Create Personal Account</Link></div></div></section>
    </div>
  );
}
