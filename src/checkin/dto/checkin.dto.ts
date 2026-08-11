import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SearchCheckinDto {
  @ApiPropertyOptional({
    example: 'maria',
    description: 'Busca por nome, CPF ou número de inscrição',
  })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  q?: string;
}

export class CompleteCheckinDto {
  @ApiPropertyOptional({
    example: 'Chegou sem documento, conferido pelo padrinho',
    description: 'Observação registrada no atendimento',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}

export class CheckinOperatorDto {
  @ApiProperty({ example: 'c8f4...', description: 'Id do operador' })
  id: string;

  @ApiProperty({ example: 'Maria Silva', description: 'Nome do operador' })
  name: string;
}
