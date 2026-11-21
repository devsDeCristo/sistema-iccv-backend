import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { InterestStage } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CriarOportunidadeDto {
  @ApiProperty({ example: 'Auxiliar administrativo' })
  @IsString()
  @IsNotEmpty({ message: 'Dê um título à vaga' })
  @MaxLength(120)
  titulo: string;

  @ApiProperty({
    example: 'Padaria do João',
    description: 'Quem oferece: a própria igreja ou a empresa de um membro',
  })
  @IsString()
  @IsNotEmpty({ message: 'Diga quem oferece a vaga' })
  @MaxLength(120)
  empresa: string;

  @ApiProperty({
    example: '<p>Atendimento no balcão, segunda a sábado.</p>',
    description:
      'HTML do editor (as vagas antigas são texto puro). Renderizado só pelo visualizador do Quill, que descarta o que não é formatação',
  })
  @IsString()
  @IsNotEmpty({ message: 'Descreva a vaga' })
  @MaxLength(20000)
  descricao: string;

  @ApiPropertyOptional({ example: 'Centro, Fortaleza' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  local?: string;

  @ApiPropertyOptional({
    description:
      '`false` encerra: some para os membros e não recebe candidatura',
  })
  @IsOptional()
  @IsBoolean()
  aberta?: boolean;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description:
      'Último dia para se candidatar (vale até o fim do dia). `null` tira o prazo',
    nullable: true,
  })
  @IsOptional()
  @IsDateString({}, { message: 'Data final inválida' })
  encerraEm?: string | null;

  @ApiPropertyOptional({
    example: { min: 2000, max: 2500 },
    description: 'Salário oferecido: valor (`min`) ou faixa. `null` tira',
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  salario?: { min?: number; max?: number } | null;

  @ApiPropertyOptional({
    description:
      'O formulário de candidatura (`{ campos }`, ver `formulario.ts`). Ausente na criação: o padrão',
  })
  @IsOptional()
  @IsObject()
  formulario?: { campos: unknown[] };
}

/** Edição parcial: o formulário manda tudo; encerrar/reabrir, só `aberta` */
export class AtualizarOportunidadeDto extends PartialType(
  CriarOportunidadeDto,
) {}

/** A recusa de uma proposta: o motivo é opcional e vai para quem propôs */
export class RecusarPropostaDto {
  @ApiPropertyOptional({ example: 'A vaga já foi preenchida' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}

/**
 * O acompanhamento de uma candidatura, por quem conduz a vaga: a etapa e a
 * anotação interna. Campo ausente não muda; `nota` vazia apaga. O candidato
 * não vê nenhum dos dois.
 */
export class AcompanharCandidaturaDto {
  @ApiPropertyOptional({
    enum: InterestStage,
    example: InterestStage.INTERVIEW,
  })
  @IsOptional()
  @IsEnum(InterestStage, { message: 'Etapa inválida' })
  etapa?: InterestStage;

  @ApiPropertyOptional({ example: 'Liguei dia 22; entrevista na sexta' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  nota?: string;
}
