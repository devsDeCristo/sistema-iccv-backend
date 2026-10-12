import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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
  ValidateNested,
} from 'class-validator';
import {
  FinancialEntryType,
  FinancialMethod,
  TreasuryKind,
} from '@prisma/client';

const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Os ids da tela: `pagamento:<id>` ou `manual:<id>` */
const ID_DO_LANCAMENTO = /^(pagamento|manual):[0-9a-f-]{36}$/;

export class TipoDaTesourariaQuery {
  @ApiProperty({ enum: TreasuryKind })
  @IsEnum(TreasuryKind)
  tipo: TreasuryKind;
}

export class CriarTesourariaDto {
  @ApiProperty({ enum: TreasuryKind })
  @IsEnum(TreasuryKind)
  kind: TreasuryKind;

  /** Evento do sistema (só no tipo EVENT) */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  eventId?: string;

  /** Nome do evento fora do sistema, ou da congregação */
  @ApiPropertyOptional()
  @ValidateIf((o) => !o.eventId)
  @IsString()
  @IsNotEmpty({ message: 'Dê o nome' })
  @MaxLength(120)
  name?: string;

  /** Dia do evento fora do sistema */
  @ApiPropertyOptional({ example: '2026-11-21' })
  @IsOptional()
  @Matches(DIA, { message: 'Data no formato AAAA-MM-DD' })
  date?: string;

  /** Bairro, distrito ou cidade da congregação */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}

class ParteDto {
  @ApiProperty()
  @IsUUID()
  movimentoId: string;

  /** Só uma parte do movimento (rateio); sem valor, o que falta dele */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999.99)
  valor?: number;
}

export class DistribuirDto {
  @ApiProperty({ type: [ParteDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ParteDto)
  partes: ParteDto[];
}

export class ClassificarDto {
  /** `null` volta para "Sem categoria" */
  @ApiProperty({ nullable: true })
  @ValidateIf((o) => o.categoria !== null)
  @IsString()
  @MaxLength(60)
  categoria: string | null;
}

export class ConciliarNaTesourariaDto {
  @ApiProperty()
  @IsUUID()
  movimentoId: string;

  @ApiProperty({ type: [String], example: ['pagamento:…', 'manual:…'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Matches(ID_DO_LANCAMENTO, { each: true })
  lancamentoIds: string[];
}

export class NaoConstaDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Matches(ID_DO_LANCAMENTO, { each: true })
  lancamentoIds: string[];

  /** `false` volta para a conciliação */
  @ApiProperty()
  @IsBoolean()
  naoConsta: boolean;
}

export class LancamentoDaTesourariaDto {
  @ApiProperty({ enum: FinancialEntryType })
  @IsIn(Object.values(FinancialEntryType))
  type: FinancialEntryType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Descreva o lançamento' })
  @MaxLength(200)
  description: string;

  @ApiProperty({ example: 150 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'O valor precisa ser maior que zero' })
  @Max(9_999_999_999.99)
  amount: number;

  @ApiProperty({ example: '2026-10-03' })
  @Matches(DIA, { message: 'Data no formato AAAA-MM-DD' })
  date: string;

  @ApiPropertyOptional({ enum: FinancialMethod })
  @IsOptional()
  @IsEnum(FinancialMethod)
  method?: FinancialMethod;
}
