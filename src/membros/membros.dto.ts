import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class BuscarPessoasQuery {
  @ApiProperty({ description: 'CPF completo ou pelo menos dois nomes' })
  @IsString()
  @MaxLength(100)
  busca: string;
}

export class AdicionarMembroDto {
  @ApiProperty()
  @IsUUID()
  userId: string;
}

export class CriarFamiliaDto {
  @ApiProperty({ example: 'Família Souza' })
  @IsString()
  @IsNotEmpty({ message: 'Dê um nome à família' })
  @MaxLength(80)
  nome: string;

  @ApiProperty({ type: [String], description: 'Membros que entram nela' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Escolha ao menos uma pessoa' })
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  userIds: string[];
}

export class AtualizarFamiliaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Dê um nome à família' })
  @MaxLength(80)
  nome?: string;

  /** Membros que passam a ser desta família (saem da que estavam) */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  adicionar?: string[];
}
