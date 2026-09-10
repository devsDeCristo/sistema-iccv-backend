import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentLogSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Filtros da trilha financeira de um evento. */
export class ListPaymentLogsDto {
  @ApiPropertyOptional({ description: 'Uma cobrança específica' })
  @IsOptional()
  @IsString()
  paymentId?: string;

  @ApiPropertyOptional({ description: 'Tudo o que aconteceu com uma pessoa' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    enum: PaymentLogSource,
    description:
      'De onde veio a mudança: PANEL (alguém), WEBHOOK (PagBank), CRON (reconciliação) ou SYSTEM',
  })
  @IsOptional()
  @IsEnum(PaymentLogSource)
  source?: PaymentLogSource;

  @ApiPropertyOptional({ description: 'Início do período' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fim do período' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
