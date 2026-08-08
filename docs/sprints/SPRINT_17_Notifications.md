SPRINT 17 OBJECTIVE:
Implement notification infrastructure.

Channels:

- email
- SMS
- in-app

Use provider abstraction where reasonable.

Critical notifications cannot be disabled.

Events include:

- agreement invitation
- agreement signed
- amendment
- payment scheduled
- payment processing
- cleared
- failed
- disputed
- bank change
- card change
- authorization revoked
- hardship
- partial payment
- settlement
- security event
- staff permissions
- payout account change
- account restriction

Implement:
- notification table
- templates
- delivery status
- retry strategy
- preference model
- failure logging

No unrestricted chat.

Tests:
- critical preference override
- delivery dedupe
- authorization
- retry

Stop.