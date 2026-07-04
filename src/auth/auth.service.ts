import * as crypto from 'crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client.js';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorCodes } from '../common/constants/error-codes';
import {
  timingSafeCompare,
  encrypt,
  decrypt,
  deriveKey,
} from '../common/utils/crypto.utils';
import { appConfig } from '../config/config';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { UpdateBusinessCredentialsDto } from './dto/update-business-credentials.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import {
  ApiKeyListItem,
  BusinessProfileResult,
  CreateApiKeyResult,
  RegisterBusinessResult,
  UpdateBusinessCredentialsResult,
} from './dto/auth-responses.dto';

/** Shape of Nomba credentials required from a Business record */
interface NombaCredentialInput {
  nombaAccountId: string | null;
  nombaSubAccountId?: string | null;
  nombaClientId: string | null;
  nombaClientSecret: string | null;
  nombaWebhookSecret: string | null;
}

/** Decrypted Nomba credentials ready for API calls */
export interface DecryptedCredentials {
  nombaAccountId: string;
  nombaSubAccountId: string;
  nombaClientId: string;
  nombaClientSecret: string;
  nombaWebhookSecret: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Shared encryption key derived from ENCRYPTION_KEY config */
  private readonly encryptionKey: Buffer = deriveKey(appConfig.ENCRYPTION_KEY);

  /**
   * Encrypt individual Nomba credential fields before persisting.
   * Secrets are encrypted at rest; non-secret fields (accountId, clientId) pass through unchanged.
   */
  private encryptCredentials(
    dto: UpdateBusinessCredentialsDto | RegisterBusinessDto,
  ): Record<string, string | undefined> {
    const patch: Record<string, string | undefined> = {};

    if (dto.nombaAccountId !== undefined)
      patch['nombaAccountId'] = dto.nombaAccountId;
    if (dto.nombaSubAccountId !== undefined)
      patch['nombaSubAccountId'] = dto.nombaSubAccountId;
    if (dto.nombaClientId !== undefined)
      patch['nombaClientId'] = dto.nombaClientId;
    if (dto.nombaClientSecret !== undefined)
      patch['nombaClientSecret'] = encrypt(
        dto.nombaClientSecret,
        this.encryptionKey,
      );
    if (dto.nombaWebhookSecret !== undefined)
      patch['nombaWebhookSecret'] = encrypt(
        dto.nombaWebhookSecret,
        this.encryptionKey,
      );
    if ('webhookUrl' in dto && dto.webhookUrl !== undefined)
      patch['webhookUrl'] = dto.webhookUrl;

    return patch;
  }

  /**
   * Return Nomba credentials with secrets decrypted, suitable for use by NombaClientService.
   * Throws if any credential is missing (caller should check hasNombaCredentials first).
   */
  getDecryptedCredentials(
    business: NombaCredentialInput,
  ): DecryptedCredentials {
    const {
      nombaAccountId,
      nombaSubAccountId,
      nombaClientId,
      nombaClientSecret,
      nombaWebhookSecret,
    } = business;

    if (
      !nombaAccountId ||
      !nombaSubAccountId ||
      !nombaClientId ||
      !nombaClientSecret ||
      !nombaWebhookSecret
    ) {
      throw new Error(
        'Nomba credentials are not fully configured for this business',
      );
    }

    return {
      nombaAccountId,
      nombaSubAccountId,
      nombaClientId,
      nombaClientSecret: decrypt(nombaClientSecret, this.encryptionKey),
      nombaWebhookSecret: decrypt(nombaWebhookSecret, this.encryptionKey),
    };
  }

  private assertAdminSecret(provided: string): void {
    if (!timingSafeCompare(provided, appConfig.ADMIN_SECRET)) {
      throw new UnauthorizedException({
        message: 'Invalid admin secret',
        code: ErrorCodes.INVALID_ADMIN_SECRET,
      });
    }
  }

  async registerBusiness(
    dto: RegisterBusinessDto,
    adminSecret: string,
  ): Promise<RegisterBusinessResult> {
    this.assertAdminSecret(adminSecret);

    try {
      const encryptedCredentials = this.encryptCredentials(dto);
      const business = await this.prisma.business.create({
        data: {
          name: dto.name,
          email: dto.email,
          ...encryptedCredentials,
        },
      });
      return { businessId: business.id, name: business.name };
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          message: `A business with email '${dto.email}' already exists`,
          code: ErrorCodes.DUPLICATE_EMAIL,
        });
      }
      throw err;
    }
  }

  async updateBusinessCredentials(
    businessId: string,
    dto: UpdateBusinessCredentialsDto,
    adminSecret: string,
  ): Promise<UpdateBusinessCredentialsResult> {
    this.assertAdminSecret(adminSecret);

    const existing = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!existing) {
      throw new NotFoundException({
        message: 'Business not found',
        code: ErrorCodes.BUSINESS_NOT_FOUND,
      });
    }

    const patch = this.encryptCredentials(dto);

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: patch,
    });

    // Merge stored fields with incoming DTO to determine complete status
    const hasNombaCredentials =
      (dto.nombaAccountId ?? existing.nombaAccountId) !== null &&
      (dto.nombaSubAccountId ??
        (existing as unknown as Record<string, string | null>)
          .nombaSubAccountId) !== null &&
      (dto.nombaClientId ?? existing.nombaClientId) !== null &&
      (dto.nombaClientSecret ?? existing.nombaClientSecret) !== null &&
      (dto.nombaWebhookSecret ?? existing.nombaWebhookSecret) !== null;

    return { businessId: updated.id, name: updated.name, hasNombaCredentials };
  }

  async createApiKey(
    dto: CreateApiKeyDto,
    adminSecret: string,
  ): Promise<CreateApiKeyResult> {
    this.assertAdminSecret(adminSecret);

    const secret = crypto.randomBytes(32).toString('hex');
    const rawKey = `acctos_live_${secret}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 20);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        keyHash,
        keyPrefix,
        name: dto.name,
        businessId: dto.businessId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
    });

    // Audit: API_KEY_CREATED — store only safe metadata, never raw key
    await this.audit.log({
      businessId: dto.businessId,
      actor: 'admin',
      action: AuditAction.API_KEY_CREATED,
      metadata: {
        keyId: apiKey.id,
        keyPrefix,
        name: dto.name,
      },
    });

    return {
      keyId: apiKey.id,
      key: rawKey,
      prefix: keyPrefix,
      name: apiKey.name,
    };
  }

  async validateApiKey(rawKey: string) {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { business: true },
    });

    if (!apiKey) {
      throw new UnauthorizedException({
        message: 'Invalid API key',
        code: ErrorCodes.INVALID_API_KEY,
      });
    }

    if (apiKey.revokedAt) {
      throw new UnauthorizedException({
        message: 'API key has been revoked',
        code: ErrorCodes.API_KEY_REVOKED,
      });
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException({
        message: 'API key has expired',
        code: ErrorCodes.API_KEY_EXPIRED,
      });
    }

    // Fire-and-forget — never let a non-critical update block the request
    this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return apiKey;
  }

  async revokeApiKey(
    keyId: string,
    businessId: string,
    actor: string,
  ): Promise<void> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id: keyId, businessId },
    });

    if (!apiKey) {
      throw new NotFoundException({
        message: 'API key not found',
        code: ErrorCodes.INVALID_API_KEY,
      });
    }

    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });

    // Audit: API_KEY_REVOKED
    await this.audit.log({
      businessId,
      actor,
      action: AuditAction.API_KEY_REVOKED,
      metadata: {
        keyId,
        keyPrefix: apiKey.keyPrefix,
        name: apiKey.name,
      },
    });
  }

  async listApiKeys(businessId: string): Promise<ApiKeyListItem[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    return keys.map((k) => ({
      id: k.id,
      prefix: k.keyPrefix,
      name: k.name,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    }));
  }

  /**
   * Return the business profile for the authenticated business.
   * Sensitive credential values are never exposed — only their presence is indicated.
   */
  async getMyBusiness(businessId: string): Promise<BusinessProfileResult> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new Error('Business not found');
    }

    const b = business as unknown as Record<string, unknown>;

    return {
      id: business.id,
      name: business.name,
      email: business.email,
      webhookUrl: business.webhookUrl ?? null,
      nombaAccountId: business.nombaAccountId ?? null,
      nombaSubAccountId: (b['nombaSubAccountId'] as string | null) ?? null,
      nombaClientId: business.nombaClientId ?? null,
      nombaClientSecretSet: !!business.nombaClientSecret,
      nombaWebhookSecretSet: !!business.nombaWebhookSecret,
      hasNombaCredentials:
        !!business.nombaAccountId &&
        !!(b['nombaSubAccountId'] as string | null) &&
        !!business.nombaClientId &&
        !!business.nombaClientSecret,
      createdAt: business.createdAt,
      updatedAt: business.updatedAt,
    };
  }
}
