SPRINT 7 OBJECTIVE:
Implement evidence management and optional witnesses.

Evidence categories:

- invoice
- receipt
- contract
- estimate
- purchase order
- proof of delivery
- proof of completed work
- prior payment record
- other approved agreement evidence

Before signing:
evidence may become part of the agreement package.

After signing:
label clearly:
"Added after agreement signing."

Post-signing evidence must never appear to have existed before signature.

Implement:

- upload
- metadata
- uploader
- timestamp
- agreement association
- shared/private classification
- dispute flag
- withdrawal state
- malware/file validation abstraction
- secure signed URL access

Sensitive identity and banking records must not use ordinary agreement evidence access.

Witnesses:

- maximum two
- verified user/account
- see agreement and explicitly shared evidence
- cannot see bank credentials
- cannot see ID verification documents
- cannot amend
- cannot receive funds
- cannot approve settlement
- may attest only to exact version

Tests:

- access control
- post-signing labeling
- witness isolation
- document ownership
- file type restrictions
- oversized/malicious file handling
- version linkage

Stop.