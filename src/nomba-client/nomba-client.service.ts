import { HttpException, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Business } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { appConfig } from '../config/config';
import { ErrorCodes } from '../common/constants/error-codes';
import {
  NombaProvisionDvaRequest,
  ProvisionDvaResult,
} from './dto/provision-dva.dto.js';
import {
  NombaTransferFundsRequest,
  type TransferFundsResult,
} from './dto/transfer-funds.dto.js';
import {
  NombaBankTransferRequest,
  BankTransferResult,
} from './dto/bank-transfer.dto.js';

/** Cached OAuth2 token for a business */
interface TokenEntry {
  token: string;
  expiresAt: Date;
}

/**
 * Nomba API response wrapper — live responses are nested under `{ code, description, data }`.
 */
interface NombaResponse<T> {
  code: string;
  description: string;
  data: T;
}

@Injectable()
export class NombaClientService {
  private readonly logger = new Logger(NombaClientService.name);
  private readonly http: AxiosInstance;

  /**
   * In-memory OAuth2 token cache keyed by business ID.
   * Tokens are cached with a 60-second safety margin before expiry.
   */
  private readonly tokenCache = new Map<string, TokenEntry>();

  constructor(private readonly authService: AuthService) {
    this.http = axios.create({
      baseURL: appConfig.NOMBA_API_BASE_URL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Mock mode guard ───────────────────────────────────────────────────────

  private get isMock(): boolean {
    return appConfig.NOMBA_MOCK_MODE;
  }

  // ─── OAuth2 token management ────────────────────────────────────────────────

  /**
   * Return a valid OAuth2 Bearer token for the given business.
   *
   * Uses an in-memory LRU-friendly cache. If the cached token has more than
   * 60 seconds of remaining lifetime it is returned directly. Otherwise a new
   * token is obtained from the Nomba OAuth2 endpoint.
   */
  async getToken(business: Business): Promise<string> {
    if (this.isMock) {
      return 'mock_token';
    }

    const cached = this.tokenCache.get(business.id);
    if (cached && cached.expiresAt.getTime() - 60_000 > Date.now()) {
      return cached.token;
    }

    const creds = this.authService.getDecryptedCredentials(business);

    const { data } = await this.http
      .post<
        NombaResponse<{
          access_token: string;
          expiresAt: string;
        }>
      >(
        '/v1/auth/token/issue',
        {
          client_id: creds.nombaClientId,
          client_secret: creds.nombaClientSecret,
          grant_type: 'client_credentials',
        },
        {
          headers: { accountId: creds.nombaAccountId },
        },
      )
      .catch((err) => {
        throw this.mapError(err, 'Failed to obtain Nomba OAuth2 token');
      });

    const tokenData = data.data;
    const expiresAt = new Date(tokenData.expiresAt);
    const entry: TokenEntry = {
      token: tokenData.access_token,
      expiresAt,
    };

    this.tokenCache.set(business.id, entry);
    return entry.token;
  }

  // ─── DVA provisioning ──────────────────────────────────────────────────────

  /**
   * Provision a new DVA (virtual account) at Nomba.
   *
   * POST /v1/accounts/virtual
   *
   * In mock mode returns a deterministic-like fake account immediately
   * without any HTTP call.
   */
  async provisionDva(
    business: Business,
    dto: NombaProvisionDvaRequest,
  ): Promise<ProvisionDvaResult> {
    if (this.isMock) {
      return this.mockProvisionDva();
    }

    const token = await this.getToken(business);
    const accountId = this.getNombaAccountId(business);
    const subAccountId = this.getNombaSubAccountId(business);

    const { data } = await this.http
      .post<
        NombaResponse<{
          accountRef: string;
          bankAccountNumber: string;
          bankName: string;
          accountName: string;
          bankAccountName: string;
        }>
      >(
        `/v1/accounts/virtual/${subAccountId}`,
        {
          accountRef: dto.accountRef,
          accountName: dto.accountName,
          ...(dto.bvn ? { bvn: dto.bvn } : {}),
          ...(dto.expiryDate ? { expiryDate: dto.expiryDate } : {}),
          ...(dto.expectedAmount !== undefined
            ? { expectedAmount: dto.expectedAmount }
            : {}),
        },
        {
          headers: this.authHeaders(token, accountId),
        },
      )
      .catch((err) => {
        throw this.mapError(err, 'Nomba DVA provisioning failed');
      });

    return {
      accountRef: data.data.accountRef,
      accountNumber: data.data.bankAccountNumber,
      bankName: data.data.bankName,
      accountName: data.data.accountName,
      bankAccountName: data.data.bankAccountName,
    };
  }

  // ─── Wallet transfer (P2P between Nomba accounts) ──────────────────────────

  /**
   * Transfer funds between two Nomba accounts (wallet P2P).
   *
   * POST /v2/transfers/wallet
   *
   * In mock mode this is a no-op that returns a fake success response.
   */
  async transferFunds(
    business: Business,
    dto: NombaTransferFundsRequest,
  ): Promise<TransferFundsResult> {
    if (this.isMock) {
      return this.mockTransferFunds(dto);
    }

    const token = await this.getToken(business);
    const accountId = this.getNombaAccountId(business);

    const { data } = await this.http
      .post<
        NombaResponse<{
          id: string;
          amount: number;
          fee: number;
          status: string;
          type: string;
        }>
      >(
        '/v2/transfers/wallet',
        {
          amount: dto.amount,
          receiverAccountId: dto.receiverAccountId,
          merchantTxRef: dto.merchantTxRef,
          narration: dto.narration ?? 'AccountOS transfer',
        },
        {
          headers: this.authHeaders(token, accountId),
        },
      )
      .catch((err) => {
        throw this.mapError(err, 'Nomba wallet transfer failed');
      });

    const transferData = data.data;
    return {
      transactionRef: transferData.id,
      status: transferData.status,
      amount: transferData.amount,
      fee: transferData.fee,
    };
  }

  // ─── Bank transfer (to external bank accounts — RELEASE_FUNDS action) ──────

  /**
   * Transfer funds from the Nomba wallet to an external bank account.
   *
   * POST /v2/transfers/bank
   *
   * In mock mode returns a fake success response.
   */
  async bankTransfer(
    business: Business,
    dto: NombaBankTransferRequest,
  ): Promise<BankTransferResult> {
    if (this.isMock) {
      return this.mockBankTransfer(dto);
    }

    const token = await this.getToken(business);
    const accountId = this.getNombaAccountId(business);

    const { data } = await this.http
      .post<
        NombaResponse<{
          id: string;
          amount: string;
          fee: number;
          status: string;
          type: string;
        }>
      >(
        '/v2/transfers/bank',
        {
          amount: dto.amount,
          accountNumber: dto.accountNumber,
          accountName: dto.accountName,
          bankCode: dto.bankCode,
          merchantTxRef: dto.merchantTxRef,
          narration: dto.narration ?? 'AccountOS payout',
        },
        {
          headers: this.authHeaders(token, accountId),
        },
      )
      .catch((err) => {
        throw this.mapError(err, 'Nomba bank transfer failed');
      });

    const transferData = data.data;
    return {
      transactionRef: transferData.id,
      status: transferData.status,
      amount: Number(transferData.amount),
      fee: transferData.fee,
    };
  }

  // ─── Account lifecycle ────────────────────────────────────────────────────

  /**
   * Expire (close) a Nomba virtual account — permanently disables the DVA.
   *
   * DELETE /v1/accounts/virtual/{identifier}
   *
   * In mock mode this is a no-op.
   */
  async expireAccount(
    business: Business,
    accountIdentifier: string,
  ): Promise<void> {
    if (this.isMock) return;

    const token = await this.getToken(business);
    const accountId = this.getNombaAccountId(business);

    await this.http
      .delete(`/v1/accounts/virtual/${accountIdentifier}`, {
        headers: this.authHeaders(token, accountId),
      })
      .catch((err) => {
        throw this.mapError(err, 'Nomba account expiry failed');
      });
  }

  // ─── Mock mode helpers ─────────────────────────────────────────────────────

  private mockProvisionDva(): ProvisionDvaResult {
    const timestamp = Date.now();
    const randomDigits = String(Math.floor(1000000 + Math.random() * 9000000));
    return {
      accountRef: `mock_ref_${timestamp}`,
      accountNumber: `990${randomDigits}`,
      bankName: 'Nombank MFB (Mock)',
      accountName: 'Mock Account',
      bankAccountName: 'Nomba/Mock Account',
    };
  }

  private mockTransferFunds(
    dto: NombaTransferFundsRequest,
  ): TransferFundsResult {
    const amount = dto.amount ?? 0;
    return {
      transactionRef: `mock_txn_${Date.now()}`,
      status: 'SUCCESS',
      amount,
      fee: 0,
    };
  }

  private mockBankTransfer(dto: NombaBankTransferRequest): BankTransferResult {
    return {
      transactionRef: `mock_bank_txn_${Date.now()}`,
      status: 'SUCCESS',
      amount: dto.amount,
      fee: 0,
    };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private getNombaAccountId(business: Business): string {
    if (!business.nombaAccountId) {
      throw new HttpException(
        {
          message: 'Business has no Nomba account ID configured',
          code: ErrorCodes.NOMBA_API_ERROR,
        },
        502,
      );
    }
    return business.nombaAccountId;
  }

  private getNombaSubAccountId(business: Business): string {
    const subAccountId = (business as unknown as Record<string, string | null>)
      .nombaSubAccountId;
    if (!subAccountId) {
      throw new HttpException(
        {
          message: 'Business has no Nomba sub-account ID configured',
          code: ErrorCodes.NOMBA_API_ERROR,
        },
        502,
      );
    }
    return subAccountId;
  }

  private authHeaders(
    token: string,
    accountId: string,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      accountId,
    };
  }

  /**
   * Map an axios error to a NestJS HttpException with the NOMBA_API_ERROR
   * code and the Nomba response body preserved in metadata.
   */
  private mapError(err: unknown, fallbackMessage: string): HttpException {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const nombaBody: Record<string, unknown> | undefined = err.response
        .data as Record<string, unknown> | undefined;

      return new HttpException(
        {
          message: `Nomba API error: ${(nombaBody?.description as string) ?? err.message}`,
          code: ErrorCodes.NOMBA_API_ERROR,
          metadata: nombaBody,
        },
        status >= 500 ? 502 : status,
      );
    }

    return new HttpException(
      {
        message: fallbackMessage,
        code: ErrorCodes.NOMBA_API_ERROR,
      },
      502,
    );
  }
}
