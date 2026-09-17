# RDS CA bundle

`rds-ca-rsa2048-g1`, which is the CA our instance presents
(`aws rds describe-db-instances --query 'DBInstances[0].CACertificateIdentifier'`).

## Why this file exists

`pg` 8.23 treats `sslmode=require` as `verify-full`, so it verifies the server
certificate against a trust store. Node's built-in store contains public web CAs,
not Amazon's private RDS CAs, so every connection failed with:

    Error: self-signed certificate in certificate chain
    code: 'SELF_SIGNED_CERT_IN_CHAIN'

The migration task could not reach the database at all. Each service that talks to
Postgres copies this file into its runtime image and sets `NODE_EXTRA_CA_CERTS`,
which Node reads automatically -- no application code change.

## Why committed rather than `ADD`-ed from the URL

`ADD https://truststore.pki.rds.amazonaws.com/...` re-downloads on every build: the
build then fails when the truststore is unreachable, and the trusted certificates
can change between two builds of the same commit without showing in any diff. A
committed file is reproducible and reviewable -- which, for a trust anchor, is the
point.

## Provenance

    curl -fsS -o rds-ca.pem \
      https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem

Retrieved 2026-09-17. 3 certificates: RSA2048 G1, RSA4096 G1, ECC384 G1.
Verify with:

    openssl crl2pkcs7 -nocrl -certfile rds-ca.pem \
      | openssl pkcs7 -print_certs -noout | grep subject

## Rotation

Amazon rotates these. When `CACertificateIdentifier` changes, re-download and
rebuild. Region-specific: this is the us-east-1 bundle (ADR 0002 fixes the region).
