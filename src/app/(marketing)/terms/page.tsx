import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocument, LegalSection } from "@/components/LegalDocument";
import { LEGAL_MIN_AGE_TEXT, PRIVACY_ROUTE, SMS_OPT_IN_METHOD_TEXT, SUPPORT_ROUTE } from "@/lib/legal/legalMeta";
import { SMS_CONSENT_DISCLOSURE_TEXT } from "@/lib/notify/smsConsentDisclosure";

export const metadata: Metadata = {
  title: "Terms of Service",
};

/**
 * B0-C (Privacy Policy + Terms of Service — contract freeze + implementation): replaces the prior
 * `LegalPlaceholder`-based "not yet finalized" content. Written strictly against this pass's own
 * frozen content contract — see the companion report (`ENHANCEMENT_B0_C_PRIVACY_TERMS.md`) for the
 * specific source files traced before writing this page, and Section Q there for every fact this
 * pass deliberately declined to invent (governing law, arbitration, indemnification, a specific
 * pricing plan, a legal entity name, etc.) rather than guessing one.
 *
 * The SMS section quotes `SMS_CONSENT_DISCLOSURE_TEXT` — the same single source of truth the live
 * consent UI, API, and Privacy Policy already use — so this page can never drift out of sync with
 * what B0-B's consent architecture actually discloses.
 */
export default function TermsPage() {
  return (
    <LegalDocument title="Terms of Service">
      <LegalSection id="acceptance" title="Acceptance of Terms">
        <p>
          By accessing or using Paid2You, you agree to these Terms of Service and to the{" "}
          <Link href={PRIVACY_ROUTE}>Privacy Policy</Link>, which is incorporated into these Terms by
          reference. If you do not agree, do not use the Service.
        </p>
      </LegalSection>

      <LegalSection id="eligibility" title="Eligibility">
        <p>
          Paid2You accounts are for individuals who are {LEGAL_MIN_AGE_TEXT} and who are able to enter into a
          binding agreement. By creating an account, you represent that you meet this requirement and that the
          account information you provide is accurate.
        </p>
      </LegalSection>

      <LegalSection id="accounts-security" title="Accounts and Security">
        <p>
          You are responsible for providing accurate account information, for safeguarding your login
          credentials and any authentication method associated with your account, and for promptly addressing
          any suspected unauthorized access to your account. Paid2You may use identity or security checks in
          connection with your account. Paid2You does not guarantee that any identity-verification or security
          check will be successful or will detect every instance of fraud or misuse.
        </p>
      </LegalSection>

      <LegalSection id="platform-role" title="Paid2You's Platform Role">
        <p>
          Paid2You provides technology that lets participating parties create, review, sign, administer,
          document, and service payment arrangements. The underlying repayment obligation or arrangement is
          between the participating parties themselves — Paid2You is not a party to that obligation merely
          because its platform records or administers the arrangement, and Paid2You is not the party promising
          repayment under any arrangement created using the Service.
        </p>
        <p>
          Paid2You does not guarantee that a counterparty to an arrangement will perform their obligations, and
          does not determine the legal validity of every underlying claim or obligation between the parties.
        </p>
        <p>
          Paid2You does not make loans or extend credit to users, and does not set or charge interest on the
          underlying repayment arrangement between parties (see &quot;No-Interest Arrangements&quot; below).
          Fees Paid2You itself may charge for use of the Service are separate from the underlying arrangement
          between the parties (see &quot;Fees&quot; below).
        </p>
      </LegalSection>

      <LegalSection id="no-interest" title="No-Interest Arrangements">
        <p>
          Paid2You&apos;s payment-arrangement functionality is intended for repayment arrangements without
          interest. You may not use Paid2You&apos;s arrangement functionality to impose or collect interest
          through a payment arrangement created on Paid2You.
        </p>
      </LegalSection>

      <LegalSection id="user-responsibilities" title="Your Responsibilities for Arrangements">
        <p>When you use Paid2You to create, accept, or participate in a payment arrangement, you are responsible for:</p>
        <ul>
          <li>the truthfulness and accuracy of the information you enter;</li>
          <li>having the authority to enter into the arrangement;</li>
          <li>reviewing the terms of an arrangement before accepting or signing it;</li>
          <li>complying with applicable law;</li>
          <li>keeping your payment and contact information accurate and current; and</li>
          <li>the obligations you voluntarily undertake through an arrangement.</li>
        </ul>
        <p>
          Paid2You does not provide legal, tax, or financial advice, and you should obtain professional advice
          where appropriate before entering into a payment arrangement.
        </p>
      </LegalSection>

      <LegalSection id="e-signatures" title="Electronic Agreements and Signatures">
        <p>
          Paid2You lets you review and electronically acknowledge or sign payment arrangements through the
          Service. Electronic signatures and records may have legal effect subject to applicable law. Paid2You
          does not guarantee that every agreement entered into through the Service is enforceable in every
          jurisdiction.
        </p>
      </LegalSection>

      <LegalSection id="payments-providers" title="Payments and Payment Providers">
        <p>
          Certain payment features rely on third-party payment providers. You may be required to connect or
          verify a payment method to use those features. The timing of settlement can depend on the systems of
          a payment provider or a financial institution, and a payment may fail, be returned, reverse, be
          disputed, or otherwise not settle. Paid2You does not guarantee the timing of settlement or the
          availability of funds in connection with any payment. By initiating or approving a payment action
          through the Service or a connected payment-provider flow, you authorize that action.
        </p>
      </LegalSection>

      <LegalSection id="fees" title="Fees">
        <p>
          Paid2You may charge platform or service fees, disclosed within the Service where applicable.
          Separately, a third-party payment provider may charge its own transaction or payment-processing
          fees; those processor fees are separate from, and not included in, any Paid2You platform fee. Where
          the Service displays applicable costs before you confirm a transaction or arrangement, you should
          review them before proceeding. Paid2You does not absorb third-party transaction-processing fees on
          your behalf.
        </p>
      </LegalSection>

      <LegalSection id="sms-terms" title="SMS Terms">
        <p>
          By affirmatively opting in {SMS_OPT_IN_METHOD_TEXT}, you agree to receive transactional text
          messages from Paid2You concerning account activity, security, payment arrangements, payments, and
          other related service activity.
        </p>
        <p>{SMS_CONSENT_DISCLOSURE_TEXT}</p>
        <ul>
          <li>These text messages are transactional/service messages — Paid2You does not authorize marketing or promotional text messages through this program.</li>
          <li>Consent applies to the verified phone number associated with your opt-in. Changing your verified phone number may require new, fresh consent before transactional text messages are sent to the new number.</li>
          <li>Replying STOP suppresses applicable transactional text messages to that phone number.</li>
          <li>You do not opt in by sending a text message containing a keyword — opt-in is completed {SMS_OPT_IN_METHOD_TEXT}.</li>
        </ul>
      </LegalSection>

      <LegalSection id="otp" title="Security and One-Time Codes">
        <p>
          Paid2You may send a one-time authentication or security code by text message when you request one,
          such as during multi-factor authentication or a security step-up. That is a separate basis from the
          optional, ongoing transactional SMS program described above, and these Terms do not change how
          Paid2You&apos;s authentication features work.
        </p>
      </LegalSection>

      <LegalSection id="communications" title="Communications">
        <p>
          Paid2You may communicate with you through in-app notifications, email, text message where you are
          eligible and have consented, and other methods you choose to use to share information (such as
          sharing a secure invitation link). Paid2You does not guarantee delivery of every message.
        </p>
      </LegalSection>

      <LegalSection id="invitations" title="Invitations and Counterparties">
        <p>
          Paid2You lets users send secure invitations to propose a payment arrangement to another person. A
          secure invitation link may be shared through any available sharing method. Where the recipient is a
          registered Paid2You user, Paid2You may also send that recipient an automated text message about the
          invitation, but only where the applicable SMS consent requirements described in the Privacy Policy
          and these Terms are satisfied. Paid2You does not send an automated text message to someone who has
          not met those requirements.
        </p>
      </LegalSection>

      <LegalSection id="prohibited-use" title="Prohibited Use">
        <p>You may not use Paid2You for:</p>
        <ul>
          <li>unlawful activity;</li>
          <li>fraud;</li>
          <li>impersonating another person or entity;</li>
          <li>unauthorized access to accounts or systems;</li>
          <li>abuse or harassment of other users;</li>
          <li>falsifying information related to an arrangement or payment;</li>
          <li>attempting to circumvent security or platform controls;</li>
          <li>introducing malicious code or interfering with the Service; or</li>
          <li>violating another person&apos;s rights.</li>
        </ul>
      </LegalSection>

      <LegalSection id="user-content" title="User Content and Records">
        <p>
          Where the Service lets you provide information or records in connection with an arrangement, you
          remain responsible for what you provide, and you grant Paid2You the permission necessary to host,
          process, and display that information as needed to provide the Service. Paid2You does not claim
          ownership of the information or records you provide, and does not obtain a broad, ongoing right to
          use them for promotional purposes.
        </p>
      </LegalSection>

      <LegalSection id="ip" title="Paid2You Intellectual Property">
        <p>
          The Paid2You service, software, and branding — other than information or records you provide —
          belong to Paid2You or its licensors. These Terms do not grant you any right to use Paid2You&apos;s
          branding or platform materials except as necessary to use the Service as intended.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="Service Availability and Changes">
        <p>
          Paid2You may maintain, update, modify, suspend, or discontinue aspects of the Service at any time.
          Paid2You does not guarantee that the Service will be available on an uninterrupted basis.
        </p>
      </LegalSection>

      <LegalSection id="termination" title="Account Restriction and Termination">
        <p>
          Paid2You may restrict or suspend your access to the Service for reasons such as security, suspected
          fraud, legal requirements, or a material violation of these Terms. Restricting or terminating an
          account does not automatically delete records Paid2You is required or entitled to retain, such as
          agreement, payment, or audit records.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="Disclaimers">
        <p>
          To the extent permitted by applicable law, the Service is provided on an &quot;as available&quot;
          basis, without a guarantee that it will operate on an uninterrupted or error-free basis. Paid2You
          does not guarantee that a counterparty to an arrangement will perform, that every arrangement entered
          into through the Service is legally enforceable, or any particular outcome from a payment
          provider&apos;s settlement of a transaction.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Limitation of Liability">
        <p>
          To the fullest extent permitted by applicable law, Paid2You and its personnel will not be liable for
          indirect, incidental, consequential, special, or punitive damages arising out of or relating to your
          use of the Service, except to the extent such liability cannot be excluded under applicable law.
        </p>
      </LegalSection>

      <LegalSection id="indemnification" title="Indemnification">
        <p>
          These Terms do not currently include a separate provision requiring you to indemnify Paid2You. If
          Paid2You adopts one in the future, it will appear in an updated version of these Terms.
        </p>
      </LegalSection>

      <LegalSection id="governing-law" title="Governing Law and Dispute Resolution">
        <p>
          These Terms do not currently designate a governing law, a required venue, or a specific
          dispute-resolution procedure. If Paid2You adopts one in the future, it will appear in an updated
          version of these Terms.
        </p>
      </LegalSection>

      <LegalSection id="changes-to-terms" title="Changes to Terms">
        <p>
          Paid2You may update these Terms from time to time. When it does, the Last Updated date above will be
          revised. For material changes, Paid2You may provide reasonable notice where appropriate. Changes to
          these Terms do not retroactively and silently alter the terms of a payment arrangement you already
          entered into before the change.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions about these Terms can be submitted through the <Link href={SUPPORT_ROUTE}>Support</Link> page.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
