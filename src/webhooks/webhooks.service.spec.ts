import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService (HMAC verification — C3)', () => {
  let service: WebhooksService;
  let mockPrisma: any;
  let mockAuthService: any;
  let mockQueue: any;

  // The plaintext secret Nomba signs with; the DB stores an "encrypted" form.
  const PLAINTEXT_SECRET = 'whsec_plaintext_value';
  const ENCRYPTED_SECRET = 'enc:whsec_plaintext_value';

  const account = {
    id: 'acc_1',
    accountRef: 'cust-001',
    accountNumber: '1234567890',
    businessId: 'biz_1',
    status: 'ACTIVE',
    customer: {
      displayName: 'Alice',
      kycTier: 'TIER_1',
      business: { nombaWebhookSecret: ENCRYPTED_SECRET },
    },
  };

  function sign(body: Buffer, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  beforeEach(() => {
    mockPrisma = {
      account: { findUnique: jest.fn().mockResolvedValue(account) },
    };

    // The service must decrypt the stored secret before HMAC.
    mockAuthService = {
      decryptWebhookSecret: jest.fn().mockReturnValue(PLAINTEXT_SECRET),
    };

    mockQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    service = new WebhooksService(mockPrisma, mockAuthService, mockQueue);
  });

  function makeBody() {
    return Buffer.from(
      JSON.stringify({
        eventId: 'evt_1',
        eventType: 'payment_success',
        data: { transactionRef: 'txn_1', accountNumber: '1234567890', amount: 5000000 },
      }),
    );
  }

  it('accepts a webhook signed with the DECRYPTED secret and enqueues it', async () => {
    const body = makeBody();
    const signature = sign(body, PLAINTEXT_SECRET);

    const result = await service.processInflow(body, signature);

    expect(result).toEqual({ received: true });
    expect(mockAuthService.decryptWebhookSecret).toHaveBeenCalledWith(
      ENCRYPTED_SECRET,
    );
    expect(mockQueue.add).toHaveBeenCalled();
  });

  it('rejects a webhook signed with the still-encrypted secret (the old bug)', async () => {
    const body = makeBody();
    // Signing with the ciphertext must NOT verify — proves we decrypt.
    const signature = sign(body, ENCRYPTED_SECRET);

    await expect(service.processInflow(body, signature)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('returns 401 (not a crash) for a malformed/short signature — H1 length guard', async () => {
    const body = makeBody();

    await expect(service.processInflow(body, 'deadbeef')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('rejects when the signature header is missing', async () => {
    const body = makeBody();

    await expect(service.processInflow(body, undefined)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // ── H2: unknown account must NOT enqueue (unverifiable) ───────────────────

  it('does not enqueue for an unknown account (H2 — no unauthenticated queue write)', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);
    const body = makeBody();

    const result = await service.processInflow(body, 'anything');

    expect(result).toEqual({ received: true });
    expect(mockQueue.add).not.toHaveBeenCalled();
    // Never even reaches decryption for an unknown account.
    expect(mockAuthService.decryptWebhookSecret).not.toHaveBeenCalled();
  });
});
