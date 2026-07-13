# Key and secret handling

This kit uses SHA-256 seals and a private blinding seed. Hashes provide integrity, not confidentiality.

The custodian should keep:

- plaintext questions;
- answer keys;
- blinding seed;
- unblinding map;
- judge identities where necessary;

outside the system-owner repository and inaccessible to the evaluated process.

For encrypted transfer, use an organization-approved tool and key-management procedure. This kit intentionally does not embed encryption code or generate long-lived keys.
