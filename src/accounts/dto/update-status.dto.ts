import { IsString, IsNotEmpty, IsEnum } from 'class-validator';
import { AccountStatus } from '@prisma/client';

export class UpdateStatusDto {
  @IsEnum(AccountStatus)
  @IsNotEmpty()
  status!: AccountStatus;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
