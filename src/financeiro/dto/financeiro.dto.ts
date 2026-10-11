import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  FinancialCategory,
  FinancialEntrySource,
  FinancialEntryType,
  FinancialMethod,
} from '@prisma/client';

/** Dia sem hora, como o campo de data manda: "2026-10-03" */
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAGEM_DIA = 'Data no formato AAAA-MM-DD';

export class CreateTitherDto {
  @ApiProperty({ description: 'O usuário que passa a ser dizimista' })
  @IsUUID()
  userId: string;

  @ApiPropertyOptional({ example: '2024-03-01' })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  since?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** O dízimo combinado. Ver `Tither.expectedAmount` */
  @ApiPropertyOptional({ nullable: true, example: 150 })
  @ValidateIf(
    (o) => o.expectedAmount !== undefined && o.expectedAmount !== null,
  )
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Valor com no máximo dois decimais' },
  )
  @Min(0.01, { message: 'O valor do dízimo precisa ser maior que zero' })
  @Max(9_999_999_999.99)
  expectedAmount?: number | null;
}

export class UpdateTitherDto {
  /** `null` apaga o valor: todo crédito da pessoa volta a ser dízimo */
  @ApiPropertyOptional({ nullable: true, example: 150 })
  @ValidateIf(
    (o) => o.expectedAmount !== undefined && o.expectedAmount !== null,
  )
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Valor com no máximo dois decimais' },
  )
  @Min(0.01, { message: 'O valor do dízimo precisa ser maior que zero' })
  @Max(9_999_999_999.99)
  expectedAmount?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** `null` apaga a data */
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((o) => o.since !== undefined && o.since !== null)
  @Matches(DIA, { message: MENSAGEM_DIA })
  since?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((o) => o.notes !== undefined && o.notes !== null)
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class ListTithersQuery {
  @ApiPropertyOptional({ description: 'Ano dos totais. Padrão: o atual' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  ano?: number;
}

export class SearchUsersQuery {
  @ApiProperty({ description: 'Nome (3+ letras) ou CPF completo' })
  @IsString()
  @MaxLength(100)
  busca: string;
}

export class CreateEntryDto {
  @ApiProperty({ enum: FinancialEntryType })
  @IsEnum(FinancialEntryType)
  type: FinancialEntryType;

  @ApiProperty({ enum: FinancialCategory })
  @IsEnum(FinancialCategory)
  category: FinancialCategory;

  @ApiProperty({ description: 'Em reais, sempre positivo', example: 150.5 })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Valor com no máximo dois decimais' },
  )
  @Min(0.01, { message: 'O valor precisa ser maior que zero' })
  @Max(9_999_999_999.99)
  amount: number;

  @ApiProperty({ example: '2026-10-03' })
  @Matches(DIA, { message: MENSAGEM_DIA })
  date: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Descreva o lançamento' })
  @MaxLength(200)
  description: string;

  @ApiPropertyOptional({ enum: FinancialMethod, nullable: true })
  @ValidateIf((o) => o.method !== undefined && o.method !== null)
  @IsEnum(FinancialMethod)
  method?: FinancialMethod | null;

  /** O dizimista (ou quem contribuiu). Precisa ser dizimista desta igreja. */
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((o) => o.userId !== undefined && o.userId !== null)
  @IsUUID()
  userId?: string | null;
}

export class UpdateEntryDto extends PartialType(CreateEntryDto) {}

export class ListEntriesQuery {
  @ApiPropertyOptional({ description: 'Primeiro dia. Padrão: dia 1 do mês' })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  de?: string;

  @ApiPropertyOptional({ description: 'Último dia. Padrão: hoje' })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  ate?: string;

  @ApiPropertyOptional({ enum: FinancialEntryType })
  @IsOptional()
  @IsEnum(FinancialEntryType)
  type?: FinancialEntryType;

  @ApiPropertyOptional({ enum: FinancialCategory })
  @IsOptional()
  @IsEnum(FinancialCategory)
  category?: FinancialCategory;

  @ApiPropertyOptional({ enum: FinancialEntrySource })
  @IsOptional()
  @IsEnum(FinancialEntrySource)
  source?: FinancialEntrySource;

  @ApiPropertyOptional({ description: 'Descrição, pagador ou dizimista' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  busca?: string;
}
