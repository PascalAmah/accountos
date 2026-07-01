import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload sent to Nomba's wallet transfer (P2P) endpoint.
 *
 * POST /v2/transfers/wallet
 *
 * @see https://developer.nomba.com/nomba-api-reference/transfers/perform-wallet-transfer-from-the-parent-account
 */
export class NombaTransferFundsRequest {
  @ApiProperty({
    description: 'Amount to transfer in Naira (not kobo)',
    example: 3500,
  })
  amount!: number;

  @ApiProperty({
    description: "The receiver's Nomba account ID (UUID)",
    example: '890022ce-bae0-45c1-9b9d-ee7872e6ca27',
  })
  receiverAccountId!: string;

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
 * Shape returned by Nomba's wallet transfer endpoint.
 */
export interface NombaTransferFundsResponse {
  id: string;
  amount: number;
  fee: number;
  status: string;
  type: string;
}

/**
 * Shape returned by `NombaClientService.transferFunds()`, normalised.
 */
export interface TransferFundsResult {
  transactionRef: string;
  status: string;
  amount: number;
  fee: number;
}
