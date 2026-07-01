import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload sent to Nomba's bank transfer endpoint.
 *
 * POST /v2/transfers/bank
 *
 * Used by the RELEASE_FUNDS rule action to pay out to external bank accounts.
 *
 * @see https://developer.nomba.com/nomba-api-reference/transfers/perform-bank-account-transfer-from-the-parent-account
 */
export class NombaBankTransferRequest {
  @ApiProperty({
    description: 'Amount to transfer in Naira',
    example: 3500,
  })
  amount!: number;

  @ApiProperty({
    description: 'Destination bank account number (10 digits)',
    example: '0554772814',
    minLength: 10,
    maxLength: 10,
  })
  accountNumber!: string;

  @ApiProperty({
    description: 'Name on the destination bank account',
    example: 'M.A Animashaun',
  })
  accountName!: string;

  @ApiProperty({
    description: 'Bank code of the recipient bank',
    example: '058',
  })
  bankCode!: string;

  @ApiProperty({
    description:
      'Unique merchant transaction reference — used as idempotency key',
    example: 'UNQ_123abGGhh5546',
  })
  merchantTxRef!: string;

  @ApiPropertyOptional({ description: 'Transfer narration' })
  narration?: string;
}

/**
 * Shape returned by Nomba's bank transfer endpoint.
 */
export interface NombaBankTransferResponse {
  id: string;
  amount: string;
  fee: number;
  status: string;
  type: string;
}

/**
 * Shape returned by `NombaClientService.bankTransfer()`, normalised.
 */
export interface BankTransferResult {
  transactionRef: string;
  status: string;
  amount: number;
  fee: number;
}
