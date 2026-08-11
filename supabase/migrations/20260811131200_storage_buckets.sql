-- Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md) and Sprint 7
-- (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md): the two private Storage buckets
-- src/lib/documents/supabaseDocumentStorage.ts (AGREEMENT_PDF_BUCKET = 'agreement-pdfs') and
-- src/lib/evidence/getEvidenceStorage.ts (EVIDENCE_BUCKET = 'agreement-evidence') require. Both
-- must be private (public = false) — "this name must be created as a private (non-public) bucket
-- in Supabase" per supabaseDocumentStorage.ts's own doc comment.
--
-- No storage.objects RLS policies are added: SupabaseDocumentStorage always connects using the
-- service-role key, which bypasses Storage RLS by design, and access control for who may ask the
-- application to issue an upload/signed URL is enforced server-side (SignatureService/
-- EvidenceService) before Storage is ever called — not by Storage-level policies. Adding unused
-- policies here would be inventing access-control surface the implemented architecture doesn't
-- use.
insert into storage.buckets (id, name, public)
values
  ('agreement-pdfs', 'agreement-pdfs', false),
  ('agreement-evidence', 'agreement-evidence', false)
on conflict (id) do nothing;
