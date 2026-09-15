import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocument, LegalSection } from "@/components/LegalDocument";
import { LEGAL_MIN_AGE_TEXT, SMS_OPT_IN_METHOD_TEXT, SUPPORT_ROUTE } from "@/lib/legal/legalMeta";
import { SMS_CONSENT_DISCLOSURE_TEXT } from "@/lib/notify/smsConsentDisclosure";

export const metadata: Metadata = {
  title: "Privacy Policy",
};

/**
 * B0-C (Privacy Policy + Terms of Service — contract freeze + implementation): replaces the prior
 * `LegalPlaceholder`-based "not yet finalized" content with a truthful, production draft, written
 * strictly against this pass's own frozen content contract. Every factual claim below was traced
 * against actual schema/service source before being written — see the companion report
 * (`ENHANCEMENT_B0_C_PRIVACY_TERMS.md`, Section B) for the specific files inspected. Nothing here
 * describes a certification, regulatory status, provider identity, or legal commitment this
 * repository does not actually establish.
 *
 * The SMS/mobile section quotes `SMS_CONSENT_DISCLOSURE_TEXT` — the exact, single source of truth
 * B0-B already uses for the live consent UI and API — rather than a hand-copied paraphrase, so this
 * page can never drift out of sync with what B0-B's consent architecture actually discloses.
 */
export default function PrivacyPage() {
  return (
    <LegalDocument title="Privacy Policy">
      <LegalSection id="scope" title="Introduction and Scope">
        <p>
          This Privacy Policy explains how Paid2You collects, uses, discloses, and otherwise handles personal
          information in connection with the Paid2You website, application, and related services (the
          &quot;Service&quot;). Paid2You is a technology platform that helps people create, review, sign,
          administer, document, and service payment arrangements. This Privacy Policy applies to Paid2You&apos;s
          own Service and does not apply to third-party websites, applications, or services that Paid2You does
          not control, even where they are linked from or connected to the Service.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="Information We Collect">
        <p>The categories below reflect what the Service actually collects. Not every category will apply to every user.</p>
        <ul>
          <li><strong>Account and profile information</strong> — such as your name, email address, date of birth, and other information you provide to create and maintain your account or a personal or business profile.</li>
          <li><strong>Contact information</strong> — such as your email address and, where you choose to verify and use one, a phone number.</li>
          <li><strong>Agreement and payment-arrangement information</strong> — information about payment arrangements you create, review, sign, or participate in, including their schedule, amounts, and status.</li>
          <li><strong>Payment and financial-account metadata</strong> — limited information about a connected financial account, described further in &quot;Financial Information&quot; below.</li>
          <li><strong>Payment and transaction records</strong> — records of payments and payment attempts associated with an arrangement, including status, amounts, and timestamps.</li>
          <li><strong>Identity and verification information</strong> — information provided to verify your identity or your business, and the resulting verification status, described further in &quot;Identity Information&quot; below.</li>
          <li><strong>Communications and support information</strong> — information you provide when you contact support or otherwise communicate with Paid2You.</li>
          <li><strong>Notification and SMS-consent information</strong> — your notification preferences and, if you opt in, information necessary to document your SMS consent (see &quot;SMS and Mobile Information&quot; below).</li>
          <li><strong>Security, audit, and technical information</strong> — information generated in connection with using the Service, such as sign-in activity, device/browser information, IP address, and records of account and security-relevant actions maintained for audit and security purposes.</li>
        </ul>
      </LegalSection>

      <LegalSection id="financial-info" title="Financial Information">
        <p>
          Connecting a financial account to Paid2You is handled through a payment provider. Sensitive bank or
          payment credentials — such as your online banking login credentials or full account and routing
          numbers — are handled by that payment provider, not stored by Paid2You in that raw form.
        </p>
        <p>
          Paid2You&apos;s own records about a connected financial account are limited to information such as a
          provider-issued token or reference, the financial institution name, the account type, the last four
          digits of an account or card number, verification status, connection status, related
          consent/authorization information, timestamps, and the user or business the account belongs to. This
          is the financial-account information Paid2You retains, as necessary to operate the Service.
        </p>
      </LegalSection>

      <LegalSection id="identity-info" title="Identity Information">
        <p>
          Where identity verification is used, it may be performed with the help of a service provider, and
          Paid2You may receive and store information such as the verification result or status, a reference
          associated with the verification, and timestamps, as necessary to administer your account. Identity
          verification is not infallible, and Paid2You does not guarantee that verification will detect every
          instance of fraud or misrepresentation.
        </p>
      </LegalSection>

      <LegalSection id="use" title="How We Use Information">
        <p>Paid2You uses information to:</p>
        <ul>
          <li>create and maintain accounts;</li>
          <li>provide and administer payment arrangements;</li>
          <li>enable review, signing, and recordkeeping for arrangements;</li>
          <li>support payments where payment functionality is available;</li>
          <li>authenticate users and help keep accounts secure;</li>
          <li>verify identity where applicable;</li>
          <li>prevent, detect, and address fraud or misuse;</li>
          <li>send service communications, including notifications about your account and arrangements;</li>
          <li>administer SMS notification preferences and consent;</li>
          <li>provide support;</li>
          <li>maintain audit and security records;</li>
          <li>enforce Paid2You&apos;s Terms of Service and other platform rules;</li>
          <li>satisfy legal and compliance obligations; and</li>
          <li>operate, maintain, and improve the Service.</li>
        </ul>
        <p>Paid2You does not use your information for targeted advertising, and the Service does not have an advertising business model.</p>
      </LegalSection>

      <LegalSection id="disclosure" title="How Information Is Disclosed">
        <p>
          Paid2You may make information associated with a payment arrangement available to the other
          participating party as necessary to present, review, sign, administer, document, or service that
          arrangement. Because the Service is designed to let parties review and act on a shared arrangement,
          not every field associated with an arrangement is private from the other party to that arrangement.
        </p>
        <p>Paid2You may also disclose information:</p>
        <ul>
          <li>
            to service providers acting on Paid2You&apos;s behalf — for example, hosting/database/storage
            providers, payment providers, identity-verification providers, and communications providers (for
            email and SMS delivery) — authorized to use information only as necessary to provide their
            services to Paid2You;
          </li>
          <li>
            where reasonably required for legal, safety, or compliance reasons — for example, to comply with
            applicable law, respond to a lawful request, protect the rights, safety, or property of Paid2You,
            its users, or others, or investigate or address a potential violation of Paid2You&apos;s Terms of
            Service; and
          </li>
          <li>
            in connection with a merger, acquisition, financing, reorganization, or sale of some or all of
            Paid2You&apos;s assets, subject to this Privacy Policy or a successor policy that applies to the
            acquired or combined business.
          </li>
        </ul>
        <p>
          Paid2You does not sell your information, and does not share your personal information with third
          parties or affiliates for their own independent marketing or promotional purposes.
        </p>
      </LegalSection>

      <LegalSection id="sms" title="SMS and Mobile Information">
        <p>{SMS_CONSENT_DISCLOSURE_TEXT}</p>
        <ul>
          <li>You may voluntarily opt in {SMS_OPT_IN_METHOD_TEXT} to receive transactional text messages. This SMS program is transactional — it is not used for marketing or promotional messages.</li>
          <li>Consent to receive transactional text messages is optional and is not required to use Paid2You.</li>
          <li>To document and manage SMS consent, Paid2You records information such as whether consent is currently active, the date consent was given or withdrawn, the source and disclosure version associated with your consent, and the verified phone number associated with that consent.</li>
          <li>
            Consent is tied to the specific verified phone number associated with your opt-in. If you later
            verify a different phone number, consent does not automatically transfer to the new number, and
            new affirmative consent may be required before Paid2You sends transactional text messages to the
            new number.
          </li>
          <li>If you opt out — including by replying STOP — that opt-out remains effective for the phone number involved, consistent with applicable carrier and industry requirements.</li>
        </ul>
        <p>
          <strong>
            Paid2You does not sell, rent, or share your mobile phone number or SMS opt-in/consent information
            with third parties or affiliates for their marketing or promotional purposes.
          </strong>{" "}
          Paid2You may disclose information to communications or service providers acting on Paid2You&apos;s
          behalf only as necessary to deliver or administer text messages, operate or protect the Service, or
          comply with applicable law.
        </p>
      </LegalSection>

      <LegalSection id="sms-security" title="Security Codes and Transactional Texts">
        <p>
          Paid2You may separately send a one-time security or verification code by text message when you
          request one as part of signing in or verifying your account — for example, multi-factor
          authentication. Requesting and receiving that code is a separate, narrower basis than the optional,
          ongoing transactional-notification SMS program described above. Opting out of transactional text
          messages does not necessarily prevent Paid2You from sending a one-time security code you have
          affirmatively requested during an authentication flow.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies and Technical Information">
        <p>
          Paid2You uses cookies and similar technologies, including cookies used to keep you signed in and to
          remember your active profile selection while using the Service. Paid2You does not currently use
          cookies for behavioral advertising.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="Data Retention">
        <p>
          Paid2You retains information for as long as reasonably necessary to provide the Service, maintain
          accurate records of payment arrangements and payments, resolve disputes, support fraud-prevention and
          security efforts, and meet legal and compliance obligations. Retention periods vary depending on the
          type of information and the purpose for which it is retained. Paid2You does not promise immediate
          deletion of agreement, payment, or audit records, which may need to be retained for recordkeeping and
          compliance purposes even after an account is closed.
        </p>
      </LegalSection>

      <LegalSection id="security" title="Security">
        <p>
          Paid2You uses administrative and technical safeguards designed to protect information appropriate to
          the nature of the Service. No method of electronic storage or transmission can be guaranteed
          completely secure.
        </p>
      </LegalSection>

      <LegalSection id="choices" title="Your Choices and Requests">
        <ul>
          <li>You may update certain account or profile information directly within the Service, where supported.</li>
          <li>You may manage your notification preferences, including the SMS consent control described above, from within your account.</li>
          <li>You may reply STOP to opt out of transactional text messages at any time, and HELP for assistance.</li>
          <li>Depending on where you live, applicable law may provide you with additional rights regarding your personal information.</li>
        </ul>
        <p>
          You can submit a request related to your information, or ask a question about this Privacy Policy,
          through the <Link href={SUPPORT_ROUTE}>Support</Link> page.
        </p>
      </LegalSection>

      <LegalSection id="children" title="Children">
        <p>
          The Service is intended for individuals who are {LEGAL_MIN_AGE_TEXT}. Paid2You does not knowingly
          offer accounts to individuals under 18.
        </p>
      </LegalSection>

      <LegalSection id="third-party" title="Third-Party Services">
        <p>
          Where the Service relies on a third-party service provider — for example, for payments, identity
          verification, or communications — that provider may have its own privacy practices governing
          information it processes. This Privacy Policy governs Paid2You&apos;s own handling of information; it
          does not limit Paid2You&apos;s own obligations described here.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to This Policy">
        <p>
          Paid2You may update this Privacy Policy from time to time. When it does, the Last Updated date above
          will be revised. For material changes, Paid2You may provide additional notice when appropriate, such
          as within the Service.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions about this Privacy Policy can be submitted through the <Link href={SUPPORT_ROUTE}>Support</Link> page.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
