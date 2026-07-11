-- M3: accountNumber must be unique so inbound webhook lookups resolve exactly
-- one account and can never cross tenants. Drops the redundant plain index that
-- the unique constraint's index supersedes.

-- DropIndex
DROP INDEX IF EXISTS "Account_accountNumber_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Account_accountNumber_key" ON "Account"("accountNumber");
