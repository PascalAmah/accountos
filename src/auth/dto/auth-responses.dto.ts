export interface RegisterBusinessResult {
  businessId: string;
  name: string;
}

export interface UpdateBusinessCredentialsResult {
  businessId: string;
  name: string;
  hasNombaCredentials: boolean;
}

export interface CreateApiKeyResult {
  keyId: string;
  key: string; // raw key — shown exactly once
  prefix: string;
  name: string;
}

export interface ApiKeyListItem {
  id: string;
  prefix: string;
  name: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface BusinessProfileResult {
  id: string;
  name: string;
  email: string;
  webhookUrl: string | null;
  nombaAccountId: string | null;
  nombaSubAccountId: string | null;
  nombaClientId: string | null;
  nombaClientSecretSet: boolean;
  nombaWebhookSecretSet: boolean;
  hasNombaCredentials: boolean;
  createdAt: Date;
  updatedAt: Date;
}
