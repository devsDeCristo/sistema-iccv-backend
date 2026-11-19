import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
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

  @ApiProperty({ example: 'Atendimento no balcão, segunda a sábado.' })
  @IsString()
  @IsNotEmpty({ message: 'Descreva a vaga' })
  @MaxLength(4000)
  descricao: string;

  @ApiPropertyOptional({ example: 'Centro, Fortaleza' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  local?: string;

  @ApiPropertyOptional({
    description: '`false` encerra: some para os membros e não recebe interesse',
  })
  @IsOptional()
  @IsBoolean()
  aberta?: boolean;
}

/** Edição parcial: o formulário manda tudo; encerrar/reabrir, só `aberta` */
export class AtualizarOportunidadeDto extends PartialType(
  CriarOportunidadeDto,
) {}
