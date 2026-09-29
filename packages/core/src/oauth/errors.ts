import type { OauthErrorCode } from '@knoverge/contracts';

/**
 * A refusal in OAuth's own words.
 *
 * Deliberately not a `DomainError`. The caller of an `/oauth` endpoint is a
 * connector written against the specification: it reads `error` and decides
 * what to do, and a code from this product's error model would mean nothing to
 * it. Everything under `/v1` keeps the product's model, including the consent
 * screen's own calls, because there the caller is this product's web interface.
 */
export class OauthFailure extends Error {
  constructor(
    readonly code: OauthErrorCode,
    readonly description: string,
    /** 400 unless the specification asks for another, as `invalid_client` does. */
    readonly status: number = 400,
  ) {
    super(description);
    this.name = 'OauthFailure';
  }
}
