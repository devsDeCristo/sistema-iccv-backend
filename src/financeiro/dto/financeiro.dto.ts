import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
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

/** O valor do dízimo do membro. Ver `User.titheAmount` */
export class ValorDoDizimoDto {
  /** `null` tira o valor: todo Pix do membro volta a ser dízimo */
  @ApiProperty({ nullable: true, example: 150 })
  @ValidateIf((o) => o.titheAmount !== null)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Valor com no máximo dois decimais' },
  )
  @Min(0.01, { message: 'O valor do dízimo precisa ser maior que zero' })
  @Max(9_999_999_999.99)
  titheAmount: number | null;
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

  /** O dizimista (ou quem contribuiu). Precisa ser membro desta igreja. */
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

  @ApiPropertyOptional({ enum: ['conciliado', 'pendente'] })
  @IsOptional()
  @IsIn(['conciliado', 'pendente'])
  conciliacao?: 'conciliado' | 'pendente';
}

/** O período da conciliação. Sem ele, do dia 1º do mês até hoje. */
export class PeriodoQuery {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  de?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  ate?: string;
}

export class ConciliarDto {
  @ApiProperty({ description: 'O lançamento importado do banco' })
  @IsUUID()
  bancoId: string;

  @ApiProperty({ description: 'O lançamento manual que é o mesmo dinheiro' })
  @IsUUID()
  manualId: string;
}
