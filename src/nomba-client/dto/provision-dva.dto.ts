import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload sent to Nomba's DVA provisioning endpoint.
 *
 * POST /v1/accounts/virtual
 *
 * @see https://developer.nomba.com/nomba-api-reference/virtual-accounts/create-virtual-account
 */
export class NombaProvisionDvaRequest {
  @ApiProperty({
    description:
      'Unique reference for the DVA (accountRef) — 16 to 64 characters',
    minLength: 16,
    maxLength: 64,
    example: '1oWbJQQHLyQqqf1SwxjSpudeA21',
  })
  accountRef!: string;

  @ApiProperty({
    example: 'Daniel Scorsese',
    description: 'Account holder name — 8 to 64 characters',
    minLength: 8,
    maxLength: 64,
  })
  accountName!: string;

  @ApiPropertyOptional({
    description: 'Account holder BVN (11 digits) for tier-2 provisioning',
    example: '12345678901',
  })
  bvn?: string;

  @ApiPropertyOptional({
    description:
      'Account expiry date. ⚠️ Be careful with this — the account becomes unusable after expiry.',
    example: '2026-01-30 12:15:00',
  })
  expiryDate?: string;

  @ApiPropertyOptional({
    description:
      'If set, the virtual account will only accept payments of exactly this amount',
    example: 200.0,
  })
  expectedAmount?: number;
}

/**
 * Shape returned by Nomba's DVA provisioning endpoint (unwrapped from data).
 */
export interface NombaProvisionDvaResponse {
  accountRef: string;
  bankAccountNumber: string;
  bankName: string;
  accountName: string;
  bankAccountName: string;
}

/**
 * Shape returned by `NombaClientService.provisionDva()`, normalised
 * regardless of whether mock mode or live mode was used.
 */
export interface ProvisionDvaResult {
  accountRef: string;
  accountNumber: string;
  bankName: string;
  accountName: string;
  bankAccountName: string;
}
