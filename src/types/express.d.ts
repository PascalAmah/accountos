import { Business, ApiKey } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      business: Business;
      apiKey: ApiKey & { business: Business };
      requestId?: string;
    }
  }
}
